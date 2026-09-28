import { Menu, Notice, Platform, setIcon } from "obsidian";
import { t } from "../i18n";
import { measureLines, measureNode, modelBounds } from "../core/measure";
import { layoutFlow } from "../core/layout-flow";
import { layoutMindmap, COLUMN_GAP, ROW_GAP } from "../core/layout-mindmap";
import {
  childrenOf,
  createModel,
  isRoot,
  nextNodeId,
  nodeById,
  rootNodes,
  type DiagramModel,
  type DiagramNode,
  type FlowDirection,
  type MindmapLayout,
  type NodeShape,
  type Point,
} from "../core/model";
import { applyPinnedPositions, parseDiagram } from "../core/parse";
import { serializeDiagram } from "../core/serialize";
import {
  createSurface,
  renderDiagram,
  type DiagramSurface,
} from "../render/svg";
import { computeFit } from "../render/fit";
import { setCssVars } from "../utils/css-vars";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";

export interface EditorPanelHost {
  /** Writes `source` back into the note. */
  save(source: string): void | Promise<void>;
  /** Closes whichever container currently hosts this panel. */
  close(): void;
  /** Moves this panel into a full tab. */
  expand(): void;
  /** Moves this panel back into a dialog. */
  collapse(): void;
}

export interface EditorPanelOptions {
  source: string;
  mode: "mindmap" | "flow";
  modeLabel: string;
  persistPositions: boolean;
  mindmapLayout: MindmapLayout;
  flowDirection: FlowDirection;
  host: EditorPanelHost;
}

const SHAPES: NodeShape[] = ["rect", "stadium", "circle", "diamond", "hexagon"];
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3.2;

type DragState =
  | { kind: "pan"; startX: number; startY: number; originTx: number; originTy: number }
  | { kind: "node"; id: string; offsetX: number; offsetY: number; moved: boolean };

/**
 * The visual editor.
 *
 * One class serves both containers: the dialog and the tab append the same
 * `root` element and hand it back, so "open as a tab" *moves* the editor rather
 * than growing a second implementation of it. All state — model, viewport,
 * selection, undo stack — lives here and survives the move.
 *
 * Everything the user changes is applied to the model immediately, but the note
 * is only written on **save** or on **close after a change**, so an accidental
 * experiment never reaches the file.
 */
export class EditorPanel {
  readonly root: HTMLElement;

  private readonly options: EditorPanelOptions;
  private model!: DiagramModel;
  private surface!: DiagramSurface;
  private canvasWrap!: HTMLElement;
  private svg!: SVGSVGElement;
  private zoomLabel!: HTMLElement;
  private emptyNote!: HTMLElement;
  private inlineWrap!: HTMLElement;
  private inlineInput!: HTMLInputElement;

  private view = { k: 1, tx: 0, ty: 0 };
  private selectedId: string | null = null;
  private editingId: string | null = null;
  private drag: DragState | null = null;
  private dragPushedUndo = false;
  private readonly pointers = new Map<number, Point>();
  private pinch = { ready: false, distance: 0 };
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private dirty = false;
  private longPressTimer: number | null = null;

  constructor(host: HTMLElement, options: EditorPanelOptions) {
    this.options = options;
    this.loadFromSource(options.source);
    this.normaliseLabels();

    this.root = h("div", { cls: "mtk-editor" });
    this.root.tabIndex = 0;

    const header = this.buildHeader();
    const toolbar = this.buildToolbar();
    this.buildCanvasInto(this.root);
    this.root.insertBefore(toolbar, this.canvasWrap);
    this.root.insertBefore(header, toolbar);
    // No hint strip on purpose: the gesture list read as noise under the canvas,
    // and the toolbar plus the context menu are the discoverable entry points.
    // `ChartPanel` dropped its copy too, so `.mtk-hints` left the stylesheet
    // along with every `chart.hint.*` string.

    this.bindCanvas();
    this.bindKeyboard();

    // Attached before the first render, for the same reason as `ChartPanel`:
    // `readPalette` reads the `--mtk-*` custom properties off the SVG, and the
    // dark overrides live behind `.theme-dark .mtk-editor`, which cannot match a
    // detached subtree. Rendering first bakes the light palette into every
    // paint attribute and leaves a dark-theme user with a light diagram until
    // something else happens to repaint.
    host.appendChild(this.root);
    this.render();

    if (Platform.isMobile) new Notice(t("notice.mobileTip"));
  }

  /* ------------------------------------------------------------- lifecycle */

  attach(host: HTMLElement): void {
    host.appendChild(this.root);
    // The container just changed size; recompute the fit on the next frame.
    window.setTimeout(() => this.fit(), 0);
  }

  destroy(): void {
    this.cancelLongPress();
    this.endInlineEdit(false);
    this.root.remove();
  }

  getSource(): string {
    return serializeDiagram(this.model, { persistPositions: this.options.persistPositions });
  }

  get hasChanges(): boolean {
    return this.dirty;
  }

  /** SVG paints are baked-in attributes, so a theme change needs a re-render. */
  repaintForTheme(): void {
    this.render();
  }

  /** Snapshot used when the panel is rebuilt in another container. */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /* ---------------------------------------------------------------- chrome */

  /** Icon-only toolbar button; `label` feeds the tooltip / accessible name. */
  private buildButton(cls: string, label: string, icon?: string): HTMLButtonElement {
    const button = h("button", { cls: `mtk-tb mtk-tb-icon-btn ${cls}`, attr: { "aria-label": label } });
    button.type = "button";
    if (icon) {
      const glyph = h("span", { cls: "mtk-tb-icon" });
      setIcon(glyph, icon);
      button.appendChild(glyph);
    }
    applyTooltip(button, label);
    return button;
  }

  private buildHeader(): HTMLElement {
    const header = h("div", { cls: "mtk-header" });
    const isMindmap = this.options.mode === "mindmap";
    header.appendChild(
      h("span", {
        cls: "mtk-title",
        text: t(isMindmap ? "editor.titleMindmap" : "editor.titleFlow"),
      })
    );
    header.appendChild(h("span", { cls: "mtk-mode", text: this.options.modeLabel }));
    // The header carries no window-level buttons on purpose. A dialog already
    // has Obsidian's own close affordances — the `modal-close-button` the base
    // `Modal` class builds, Escape, and a click on the backdrop — and a tab is
    // closed from its tab header. The window-level controls this row used to
    // hold (expand to a tab, close) are gone from both panels: `EditorPanelHost`
    // still declares them as the container protocol and `EditorSession`
    // implements them, but no button calls them today. Both editors put their
    // one visible action — save — in the toolbar, at the far left.
    return header;
  }

  private buildToolbar(): HTMLElement {
    const toolbar = h("div", { cls: "mtk-toolbar" });

    // Saving leads the toolbar: it is the one action people reach for while
    // working, and the header is where the window-level controls (expand,
    // close) belong. It keeps its own accent styling via `.mtk-tb.mtk-save`.
    const save = this.buildButton("mtk-save", t("editor.save"), "save");
    save.addEventListener("click", () => void this.save());
    toolbar.appendChild(save);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    const undo = this.buildButton("mtk-undo", t("editor.toolbar.undo"), "undo-2");
    undo.addEventListener("click", () => this.undo());
    const redo = this.buildButton("mtk-redo", t("editor.toolbar.redo"), "redo-2");
    redo.addEventListener("click", () => this.redo());
    toolbar.append(undo, redo);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    // Adding a node, deleting it and picking its shape all live in the
    // right-click menu (see openContextMenu), so the toolbar only carries the
    // whole-canvas actions: layout, history and viewport. The tidy button leads
    // the viewport group, sitting right before zoom-out, mirroring the chart
    // panel's toolbar order.
    const tidy = this.buildButton("mtk-tidy", t("editor.toolbar.layout"), "network");
    tidy.addEventListener("click", () => {
      this.pushUndo();
      // Tidying means going back to the computed layout, so every manual
      // position is released — otherwise the button would look like a no-op.
      for (const node of this.model.nodes) node.pinned = false;
      this.model.positions = {};
      this.relayout();
      this.render();
      this.fit();
      new Notice(t("notice.layoutDone"));
    });
    toolbar.appendChild(tidy);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));
    const zoomOut = this.buildButton("mtk-zoom-out", t("editor.toolbar.zoomOut"), "zoom-out");
    zoomOut.addEventListener("click", () => this.zoomBy(1 / 1.15));
    this.zoomLabel = h("span", { cls: "mtk-zoom-value", text: "100%" });
    const zoomIn = this.buildButton("mtk-zoom-in", t("editor.toolbar.zoomIn"), "zoom-in");
    zoomIn.addEventListener("click", () => this.zoomBy(1.15));
    toolbar.append(zoomOut, this.zoomLabel, zoomIn);
    return toolbar;
  }

  private buildCanvasInto(parent: HTMLElement): void {
    this.canvasWrap = h("div", { cls: "mtk-canvas" });
    this.canvasWrap.appendChild(h("div", { cls: "mtk-grid" }));

    this.surface = createSurface(this.canvasWrap);
    this.svg = this.surface.svg;

    this.emptyNote = h("div", { cls: "mtk-empty", text: t("editor.empty") });
    this.canvasWrap.appendChild(this.emptyNote);

    this.inlineWrap = h("div", { cls: "mtk-inline" });
    this.inlineInput = h("input", { cls: "mtk-inline-input" });
    this.inlineInput.type = "text";
    this.inlineInput.spellcheck = false;
    this.inlineWrap.appendChild(this.inlineInput);
    this.canvasWrap.appendChild(this.inlineWrap);

    parent.appendChild(this.canvasWrap);
  }

  /* ---------------------------------------------------------------- loading */

  /** Parse, lay out, then apply any stored manual positions. */
  private loadFromSource(source: string): void {
    const parsed = parseDiagram(source, this.options.mode);
    this.model = parsed.ok ? parsed.model : createModel(this.options.mode);
    if (!this.model.direction) this.model.direction = this.options.flowDirection;
    this.relayout();
    applyPinnedPositions(this.model);
  }

  /** Parser output has no locale; an empty label still needs something to draw. */
  private normaliseLabels(): void {
    for (const node of this.model.nodes) {
      if (!node.text.trim()) node.text = t("editor.emptyNode");
    }
  }

  /**
   * The single root of a mind map, or null for an empty canvas / flowchart.
   *
   * A mind map is defined as having exactly one root; every operation that adds
   * a node uses this root as its attachment point so the user cannot create a
   * second root by accident.
   */
  private mindmapRootId(): string | null {
    if (this.model.mode !== "mindmap") return null;
    const roots = rootNodes(this.model);
    return roots.length > 0 ? roots[0].id : null;
  }

  /**
   * Recomputes every position the user has not pinned. Called after any
   * structural change so a new node lands somewhere sensible instead of on top
   * of its neighbour.
   */
  private relayout(): void {
    if (this.model.mode === "mindmap") {
      layoutMindmap(this.model, this.options.mindmapLayout);
    } else {
      layoutFlow(this.model);
    }
  }

  /* --------------------------------------------------------------- drawing */

  private render(): void {
    renderDiagram(this.surface, this.model, {
      interactive: true,
      selectedId: this.selectedId,
    });
    this.applyViewTransform();
    this.updateChrome();
  }

  private applyViewTransform(): void {
    this.surface.layer.setAttribute(
      "transform",
      `translate(${this.view.tx},${this.view.ty}) scale(${this.view.k})`
    );
    // Single writer for the zoom readout — it used to be set here *and* next to
    // the transform, which is how a button ends up moving the canvas while the
    // percentage stays put.
    this.zoomLabel.textContent = `${Math.round(this.view.k * 100)}%`;
  }

  private updateChrome(): void {
    const undo = this.root.querySelector<HTMLButtonElement>(".mtk-undo");
    if (undo) undo.disabled = this.undoStack.length === 0;
    const redo = this.root.querySelector<HTMLButtonElement>(".mtk-redo");
    if (redo) redo.disabled = this.redoStack.length === 0;

    this.emptyNote.classList.toggle("is-visible", this.model.nodes.length === 0);
  }

  /* -------------------------------------------------------------- viewport */

  private zoomBy(factor: number, anchor?: Point): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.k * factor));
    const focus = anchor ?? {
      x: this.canvasWrap.clientWidth / 2,
      y: this.canvasWrap.clientHeight / 2,
    };
    this.view.tx = focus.x - ((focus.x - this.view.tx) / this.view.k) * next;
    this.view.ty = focus.y - ((focus.y - this.view.ty) / this.view.k) * next;
    this.view.k = next;
    this.applyViewTransform();
  }

  private fit(): void {
    const width = this.canvasWrap.clientWidth;
    const height = this.canvasWrap.clientHeight;
    if (!width || !height) return;
    const bounds = modelBounds(this.model);
    if (!bounds) {
      this.view = { k: 1, tx: width / 2, ty: height / 2 };
      this.applyViewTransform();
      return;
    }
    const spanX = Math.max(1, bounds.x2 - bounds.x1);
    const spanY = Math.max(1, bounds.y2 - bounds.y1);
    const midX = (bounds.x1 + bounds.x2) / 2;
    const midY = (bounds.y1 + bounds.y2) / 2;

    if (Platform.isMobile) {
      // On a phone the useful axis is height: fit it, anchor to the left, and
      // let the user pan sideways — the way native mind map apps behave.
      const k = Math.min((height - 44) / spanY, 1);
      this.view = { k, tx: 22 - bounds.x1 * k, ty: height / 2 - midY * k };
      this.applyViewTransform();
      return;
    }
    const k = Math.min((width - 96) / spanX, (height - 96) / spanY, 1.15);
    this.view = { k, tx: width / 2 - midX * k, ty: height / 2 - midY * k };
    this.applyViewTransform();
  }

  private toModelCoords(clientX: number, clientY: number): Point {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.tx) / this.view.k,
      y: (clientY - rect.top - this.view.ty) / this.view.k,
    };
  }

  /* ------------------------------------------------------------ mutations */

  private snapshot(): string {
    return serializeDiagram(this.model, { persistPositions: this.options.persistPositions });
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
  }

  /** The undo stack holds source text, so it can never drift from what we write. */
  private restore(source: string): void {
    this.endInlineEdit(false);
    this.loadFromSource(source);
    this.normaliseLabels();
    this.selectedId = null;
    this.render();
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
    this.dirty = true;
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.dirty = true;
  }

  private setShape(shape: NodeShape): void {
    const node = this.selectedId ? nodeById(this.model, this.selectedId) : null;
    if (!node) {
      new Notice(t("notice.selectNode"));
      return;
    }
    this.pushUndo();
    node.shape = shape;
    this.relayout();
    this.render();
  }

  private addNodeAtFreeSpot(): void {
    const bounds = modelBounds(this.model);
    this.pushUndo();
    const rootId = this.mindmapRootId();
    const id = nextNodeId(this.model);
    const newSize = measureNode({ text: t("editor.newNode"), shape: "rect" });
    this.model.nodes.push({
      id,
      alias: "",
      text: t("editor.newNode"),
      shape: "rect",
      x: bounds ? (bounds.x1 + bounds.x2) / 2 : 0,
      y: bounds ? bounds.y2 + ROW_GAP + newSize.h / 2 : 0,
      key: id,
      depth: 0,
      pinned: true,
    });
    if (rootId) {
      this.model.edges.push({ id: `e${Date.now()}`, from: rootId, to: id, label: "" });
    }
    this.selectedId = id;
    this.render();
    this.beginInlineEdit(id);
  }

  private addNodeNear(point: Point): void {
    this.pushUndo();
    const rootId = this.mindmapRootId();
    const id = nextNodeId(this.model);
    this.model.nodes.push({
      id,
      alias: "",
      text: t("editor.newNode"),
      shape: "rect",
      x: point.x,
      y: point.y,
      key: id,
      depth: 0,
      pinned: true,
    });
    if (rootId) {
      this.model.edges.push({ id: `e${Date.now()}`, from: rootId, to: id, label: "" });
    }
    this.selectedId = id;
    this.render();
    this.beginInlineEdit(id);
  }

  private addRelated(id: string, relation: "child" | "sibling"): void {
    const anchor = nodeById(this.model, id);
    if (!anchor) return;

    // Mind map: the root has no siblings, so a sibling request on the root is
    // treated as adding a child instead of creating a second root.
    if (this.model.mode === "mindmap" && relation === "sibling" && isRoot(this.model, id)) {
      relation = "child";
    }

    const shape = this.model.mode === "mindmap" ? "rect" : anchor.shape;
    const anchorSize = measureNode(anchor);
    const newSize = measureNode({ text: t("editor.newNode"), shape });

    // Where the new node *wants* to sit. Children line up in the column to the
    // right of the parent (or with existing siblings) and stack below them;
    // siblings stack below the node they were added from. Every offset is taken
    // from the measured sizes, so a second child lands under the first instead
    // of on top of it.
    let x: number;
    let y: number;
    if (relation === "child") {
      const siblings = childrenOf(this.model, id);
      x = siblings.length
        ? siblings[0].x
        : anchor.x + Math.round(anchorSize.w / 2 + COLUMN_GAP + newSize.w / 2);
      if (siblings.length) {
        let bottom = -Infinity;
        for (const child of siblings) bottom = Math.max(bottom, child.y + measureNode(child).h / 2);
        y = Math.round(bottom + ROW_GAP + newSize.h / 2);
      } else {
        y = anchor.y;
      }
    } else {
      x = anchor.x;
      y = Math.round(anchor.y + anchorSize.h / 2 + ROW_GAP + newSize.h / 2);
    }

    this.pushUndo();
    const nodeId = nextNodeId(this.model);
    this.model.nodes.push({
      id: nodeId,
      alias: "",
      text: t("editor.newNode"),
      shape,
      x,
      y,
      key: nodeId,
      depth: 0,
      pinned: true,
    });
    if (relation === "child") {
      this.model.edges.push({ id: `e${Date.now()}`, from: id, to: nodeId, label: "" });
    } else {
      const incoming = this.model.edges.find((e) => e.to === id);
      if (incoming) {
        this.model.edges.push({ id: `e${Date.now()}b`, from: incoming.from, to: nodeId, label: "" });
      }
    }
    this.settleBelow(nodeId);
    this.selectedId = nodeId;
    this.render();
    this.beginInlineEdit(nodeId);
  }

  /**
   * Final safety net after a manual add: push the new node straight down until
   * it clears every other node. The preferred spot above is already spaced, but
   * the anchor may sit in a crowded column (dragged next to a tall neighbour, or
   * a sibling the user moved underneath), so this guarantees the result reads
   * even then.
   */
  private settleBelow(id: string): void {
    const node = nodeById(this.model, id);
    if (!node) return;
    const size = measureNode(node);
    for (let guard = 0; guard < 200; guard++) {
      let blocker: DiagramNode | null = null;
      for (const other of this.model.nodes) {
        if (other.id === id) continue;
        const otherSize = measureNode(other);
        if (
          Math.abs(node.x - other.x) < (size.w + otherSize.w) / 2 + 6 &&
          Math.abs(node.y - other.y) < (size.h + otherSize.h) / 2 + 6
        ) {
          blocker = other;
          break;
        }
      }
      if (!blocker) break;
      node.y = Math.round(blocker.y + measureNode(blocker).h / 2 + ROW_GAP + size.h / 2);
    }
  }

  private deleteSelected(): void {
    if (!this.selectedId) return;
    const id = this.selectedId;

    // Mind map: deleting the root promotes its first child so the diagram
    // stays a single-root tree instead of splitting into several roots.
    if (this.model.mode === "mindmap" && isRoot(this.model, id)) {
      const kids = childrenOf(this.model, id);
      if (kids.length > 0) {
        this.pushUndo();
        const newRoot = kids[0];
        for (let i = 1; i < kids.length; i++) {
          const edge = this.model.edges.find((e) => e.from === id && e.to === kids[i].id);
          if (edge) edge.from = newRoot.id;
        }
        this.model.nodes = this.model.nodes.filter((n) => n.id !== id);
        this.model.edges = this.model.edges.filter((e) => e.from !== id && e.to !== id);
        this.selectedId = newRoot.id;
        this.relayout();
        this.render();
        return;
      }
    }

    this.pushUndo();
    const removed = this.model.edges.filter((e) => e.from === id || e.to === id).length;
    this.model.nodes = this.model.nodes.filter((n) => n.id !== id);
    this.model.edges = this.model.edges.filter((e) => e.from !== id && e.to !== id);
    this.selectedId = null;
    this.render();
    new Notice(t("notice.deleted", { count: removed }));
  }

  /* ------------------------------------------------------------- keyboard */

  private bindKeyboard(): void {
    this.root.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      const tag = (target?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;

      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") {
        if (event.shiftKey) this.redo();
        else this.undo();
        event.preventDefault();
        return;
      }
      if (mod && key === "y") {
        this.redo();
        event.preventDefault();
        return;
      }
      if (mod && key === "s") {
        void this.save();
        event.preventDefault();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (this.selectedId) {
          this.deleteSelected();
          event.preventDefault();
        }
        return;
      }
      if (event.key === "F2" && this.selectedId) {
        this.beginInlineEdit(this.selectedId);
        event.preventDefault();
        return;
      }
      if (!this.selectedId) return;
      const step = event.shiftKey ? 10 : 1;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      const node = nodeById(this.model, this.selectedId);
      if (!node) return;
      node.x += delta[0];
      node.y += delta[1];
      node.pinned = true;
      if (!this.dragPushedUndo) {
        this.undoStack.push(this.snapshot());
        this.redoStack.length = 0;
        this.dirty = true;
      }
      this.render();
      event.preventDefault();
    });
  }

  /* ----------------------------------------------------------------- menu */

  private openContextMenu(event: MouseEvent | { x: number; y: number }, node: DiagramNode | null): void {
    const menu = new Menu();
    if (node) {
      menu.addItem((item) =>
        item.setTitle(t("editor.menu.rename")).setIcon("pencil").onClick(() => this.beginInlineEdit(node.id))
      );
      menu.addItem((item) =>
        item
          .setTitle(t("editor.menu.addChild"))
          .setIcon("corner-down-right")
          .onClick(() => this.addRelated(node.id, "child"))
      );
      if (this.model.mode !== "mindmap" || !isRoot(this.model, node.id)) {
        menu.addItem((item) =>
          item
            .setTitle(t("editor.menu.addSibling"))
            .setIcon("plus")
            .onClick(() => this.addRelated(node.id, "sibling"))
        );
      }
      // Mind maps keep every node as a plain rectangle, so the shape switcher
      // only appears for flowcharts where the five shapes are meaningful.
      if (this.model.mode !== "mindmap") {
        menu.addSeparator();
        for (const shape of SHAPES) {
          menu.addItem((item) =>
            item
              .setTitle(t(`editor.shape.${shape}`))
              .setChecked(node.shape === shape)
              .onClick(() => {
                this.selectedId = node.id;
                this.setShape(shape);
              })
          );
        }
        menu.addSeparator();
      }
      menu.addItem((item) =>
        item
          .setTitle(t("editor.menu.delete"))
          .setIcon("trash-2")
          .onClick(() => {
            this.selectedId = node.id;
            this.deleteSelected();
          })
      );
    } else {
      menu.addItem((item) =>
        item.setTitle(t("editor.toolbar.addNode")).setIcon("plus").onClick(() => this.addNodeAtFreeSpot())
      );
      menu.addItem((item) =>
        item
          .setTitle(t("editor.toolbar.layout"))
          .setIcon("network")
          .onClick(() => {
            this.pushUndo();
            for (const item2 of this.model.nodes) item2.pinned = false;
            this.model.positions = {};
            this.relayout();
            this.render();
            this.fit();
          })
      );
    }

    if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    else menu.showAtPosition(event);
  }

  /* ------------------------------------------------------------- in-place */

  private beginInlineEdit(id: string): void {
    const node = nodeById(this.model, id);
    if (!node) return;
    const size = measureNode(node);
    const width = Math.max(130, size.w * this.view.k);
    const height = Math.max(34, size.h * this.view.k);
    setCssVars(this.inlineWrap, {
      "--mtk-inline-x": `${this.view.tx + node.x * this.view.k - width / 2}px`,
      "--mtk-inline-y": `${this.view.ty + node.y * this.view.k - height / 2}px`,
      "--mtk-inline-w": `${width}px`,
      "--mtk-inline-h": `${height}px`,
    });
    this.inlineWrap.classList.add("is-open");
    this.inlineInput.value = node.text;
    this.editingId = id;
    this.inlineInput.focus();
    this.inlineInput.select();
  }

  private endInlineEdit(commit: boolean): void {
    const id = this.editingId;
    this.editingId = null;
    this.inlineWrap.classList.remove("is-open");
    if (!id) return;
    const node = nodeById(this.model, id);
    const value = this.inlineInput.value.trim();
    if (commit && node && value && value !== node.text) {
      this.pushUndo();
      node.text = value;
      this.relayout();
      this.render();
    }
  }

  /* ------------------------------------------------------------ pointer io */

  private bindCanvas(): void {
    const svg = this.svg;

    svg.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const id = this.nodeIdFromEvent(event);
      const node = id ? nodeById(this.model, id) : null;
      if (node) this.selectedId = node.id;
      this.render();
      this.openContextMenu(event, node);
    });

    svg.addEventListener("pointerdown", (event) => {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.root.focus();
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (this.pointers.size > 1) {
        this.drag = null;
        return;
      }
      this.endInlineEdit(true);

      const id = this.nodeIdFromEvent(event);
      const node = id ? nodeById(this.model, id) : null;
      if (node) {
        this.selectedId = node.id;
        const point = this.toModelCoords(event.clientX, event.clientY);
        this.dragPushedUndo = false;
        this.drag = {
          kind: "node",
          id: node.id,
          offsetX: point.x - node.x,
          offsetY: point.y - node.y,
          moved: false,
        };
        this.capture(event);
        this.render();
        this.startLongPress(event, node);
        event.preventDefault();
        return;
      }

      this.selectedId = null;
      this.drag = {
        kind: "pan",
        startX: event.clientX,
        startY: event.clientY,
        originTx: this.view.tx,
        originTy: this.view.ty,
      };
      this.canvasWrap.classList.add("is-panning");
      this.capture(event);
      this.render();
    });

    svg.addEventListener("pointermove", (event) => {
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch.ready && this.pinch.distance > 0) this.zoomBy(distance / this.pinch.distance);
        this.pinch.ready = true;
        this.pinch.distance = distance;
        this.drag = null;
        return;
      }
      if (!this.drag) return;

      if (this.drag.kind === "pan") {
        this.view.tx = this.drag.originTx + (event.clientX - this.drag.startX);
        this.view.ty = this.drag.originTy + (event.clientY - this.drag.startY);
        this.applyViewTransform();
        return;
      }

      const point = this.toModelCoords(event.clientX, event.clientY);
      if (this.drag.kind === "node") {
        const node = nodeById(this.model, this.drag.id);
        if (!node) return;
        if (!this.drag.moved) {
          // Snapshot before the first pixel of movement: a snapshot taken now
          // would already contain the new position, and undo would do nothing.
          this.undoStack.push(this.snapshot());
          if (this.undoStack.length > 80) this.undoStack.shift();
          this.redoStack.length = 0;
          this.dirty = true;
        }
        node.x = point.x - this.drag.offsetX;
        node.y = point.y - this.drag.offsetY;
        node.pinned = true;
        this.drag.moved = true;
        this.render();
        return;
      }
    });

    const finish = (event: PointerEvent): void => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) {
        this.pinch.ready = false;
        this.pinch.distance = 0;
      }
      this.cancelLongPress();
      const drag = this.drag;
      this.drag = null;
      this.canvasWrap.classList.remove("is-panning");
      if (!drag) return;

      if (drag.kind === "node") {
        if (drag.moved) {
          if (!this.options.persistPositions) new Notice(t("notice.positionsOff"));
          this.render();
        }
        return;
      }
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);

    svg.addEventListener("dblclick", (event) => {
      const id = this.nodeIdFromEvent(event);
      if (id) {
        this.selectedId = id;
        this.render();
        this.beginInlineEdit(id);
        event.preventDefault();
        return;
      }
      this.addNodeNear(this.toModelCoords(event.clientX, event.clientY));
      event.preventDefault();
    });

    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        this.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      },
      { passive: false }
    );

    this.inlineInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.endInlineEdit(true);
        event.preventDefault();
      } else if (event.key === "Escape") {
        this.endInlineEdit(false);
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.inlineInput.addEventListener("blur", () => this.endInlineEdit(true));
  }

  private capture(event: PointerEvent): void {
    try {
      this.svg.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture is a nicety; dragging still works without it. */
    }
  }

  private nodeIdFromEvent(event: Event): string | null {
    const group = (event.target as Element | null)?.closest("[data-node]");
    return group?.getAttribute("data-node") ?? null;
  }

  private startLongPress(event: PointerEvent, node: DiagramNode): void {
    if (event.pointerType === "mouse") return;
    this.cancelLongPress();
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      this.drag = null;
      this.openContextMenu({ x: event.clientX, y: event.clientY }, node);
    }, 550);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer === null) return;
    window.clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  /* --------------------------------------------------------------- output */

  private async save(): Promise<void> {
    const source = this.getSource();
    this.dirty = false;
    await this.options.host.save(source);
  }

  /** Number of lines in the widest label, exposed for the status tooltip. */
  get labelLineCount(): number {
    return this.model.nodes.reduce((max, node) => Math.max(max, measureLines(node).length), 0);
  }
}
