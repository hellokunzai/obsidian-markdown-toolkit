import { Menu, Modal, Notice, Platform, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { kindById } from "../core/kinds";
import type { ChartCanvasId, Point } from "../core/model";
import { chartSpec } from "../charts/registry";
import { RELATION_GROUPS } from "../charts/specs/class-diagram";
import { CARD_OPTIONS } from "../charts/specs/er-diagram";
import { dayNum, dayStr } from "../charts/specs/gantt";
import type { ChartField, ChartHandle, RegisteredSpec } from "../charts/types";
import { nextId } from "../charts/draw";
import { paintChart } from "../charts/paint";
import { createSurface, readPalette, type DiagramSurface } from "../render/svg";
import { fitBounds } from "../render/fit";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";
import { TextToolModal } from "../ui/text-tool-modal";
import type { EditorPanelHost } from "./editor-panel";

/**
 * The visual editor for the nine charts that are not a node-and-edge graph.
 *
 * It is the sibling of `EditorPanel`, not a variant of it. That one owns a
 * `DiagramModel` and drags boxes around; this one owns nothing at all — it
 * holds an opaque `state` produced by whichever `ChartSpec` is registered for
 * the kind, and forwards every gesture to that spec. A sequence diagram drags
 * a participant to a new column, a gantt bar slides along a date axis, a pie
 * boundary re-splits two sectors: none of those are node positions, so the
 * model is the spec's business and the panel's job is everything *around* it.
 *
 * What the panel does own is the same in all nine cases, and that is the point:
 * the viewport, pointer routing, hit-testing, selection, the property panel, the
 * undo stack, save and export. So a new chart kind is a spec file and a row in
 * the registry — it never touches this file.
 *
 * Three conventions worth knowing before reading on:
 *
 *  - **The DOM is the hit test.** Every shape a spec draws carries `data-mtk`
 *    with its id. Resolving a click is `closest("[data-mtk]")`, not a second
 *    geometric implementation of what the spec already drew. Two ways of
 *    answering "what is under the cursor" is two answers that can disagree.
 *  - **The spec decides what a delta means.** `ChartHandle.drag` receives raw
 *    model-space deltas plus the snapshot `begin()` took on pointer-down; the
 *    panel never interprets them.
 *  - **Nothing is committed until it changed something.** Every mutation is
 *    bracketed by comparing `serialize()` before and after, so an undo entry
 *    is only pushed when the source text actually differs. Without that, a
 *    click that merely cancels a pending link would leave an undo step that
 *    appears to do nothing when you press it.
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3.2;
/** Movement in screen pixels before a press stops being a click. */
const CLICK_SLOP = 3;

type ChartDrag =
  | { kind: "pan"; startX: number; startY: number; originTx: number; originTy: number }
  | { kind: "grip"; handle: ChartHandle; origin: unknown; startX: number; startY: number };

export interface ChartPanelOptions {
  source: string;
  /** Which canvas to open. Always one of the chart kinds, never mindmap/flow. */
  mode: ChartCanvasId;
  host: EditorPanelHost;
  /** Obsidian app, needed to open modals (message/participant editors). */
  app: App;
}

/** Minimal view of the sequence-chart state the right-click menu and message
 * dialog need. The panel is generic and never imports the spec's `Actor`/
 * `Message` types; this structural subset is all the menu touches. */
interface SequenceActor {
  id: string;
  key: string;
  label: string;
}
interface SequenceMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  arrow: string;
  y: number;
}
interface SequenceChartShape {
  actors: SequenceActor[];
  messages: SequenceMessage[];
}

/** Structural subset of the class-diagram state the right-click menu touches.
 * The panel stays generic and never imports the spec's `ClassItem`/`ClassEdge`
 * types; this is all the menu reads or mutates. */
interface ClassItemShape {
  id: string;
  name: string;
  attrs: string[];
  methods: string[];
  pinned?: boolean;
}
interface ClassEdgeShape {
  id: string;
  from: string;
  to: string;
  op: string;
  label: string;
}
interface ClassChartShape {
  items: ClassItemShape[];
  edges: ClassEdgeShape[];
  linking: string | null;
}

/** Structural subset of the state-diagram state the right-click menu touches.
 * The `[*]` markers are derived (virtual) and deliberately not editable, so the
 * menu only ever acts on `virtual === ""` items. */
interface StateItemShape {
  id: string;
  name: string;
  virtual: "" | "start" | "end";
  pinned?: boolean;
}
interface StateEdgeShape {
  id: string;
  from: string;
  to: string;
  label: string;
}
interface StateChartShape {
  items: StateItemShape[];
  edges: StateEdgeShape[];
  linking: string | null;
}

/** Structural subset of the ER-diagram state the right-click menu touches. */
interface EntityItemShape {
  id: string;
  name: string;
  fields: string[];
  pinned?: boolean;
}
interface EntityEdgeShape {
  id: string;
  from: string;
  to: string;
  left: string;
  right: string;
  identifying: boolean;
  label: string;
}
interface ErChartShape {
  items: EntityItemShape[];
  edges: EntityEdgeShape[];
  linking: string | null;
}

/** Structural subset of the gantt state the right-click menu touches. The panel
 * stays generic and never imports the spec's `GanttTask`/`GanttChart` types; this
 * is the four fields the edit dialog reads or mutates. */
interface GanttTaskShape {
  id: string;
  name: string;
  section: string;
  /** Days since epoch, matching the spec's `start`. */
  start: number;
  days: number;
  /** Set true the moment a date/duration is edited, so the spec stops writing
   * `after <key>` for this row. */
  manual: boolean;
}
interface GanttChartShape {
  tasks: GanttTaskShape[];
}

/** Structural subset of the pie state the right-click menu touches. Mirrors the
 * gantt convention: the panel stays generic and never imports the spec's
 * `Slice`/`PieChart` types; these are the two fields the slice dialog reads. */
interface PieSliceShape {
  id: string;
  label: string;
  value: number;
}
interface PieChartShape {
  title: string;
  slices: PieSliceShape[];
}

export class ChartPanel {
  readonly root: HTMLElement;

  private readonly options: ChartPanelOptions;
  private readonly spec: RegisteredSpec;

  private state: unknown;
  private surface!: DiagramSurface;
  private canvasWrap!: HTMLElement;
  private bodyWrap!: HTMLElement;
  private propsEl!: HTMLElement;
  private svg!: SVGSVGElement;
  private zoomLabel!: HTMLElement;
  private statusLabel!: HTMLElement;
  private emptyNote!: HTMLElement;

  private view = { k: 1, tx: 0, ty: 0 };
  private selected: string | null = null;
  /** Live grips for the current drawing, rebuilt by every `repaint`. */
  private readonly handles = new Map<string, ChartHandle>();
  private drag: ChartDrag | null = null;
  /** The element the current press landed on, resolved at pointer-down. */
  private hitId: string | null = null;
  private moved = false;
  /** Source text from before the in-flight drag, so undo only stores real moves. */
  private pendingUndo: string | null = null;
  /** Source text from before the focused property field was touched. */
  private fieldUndo: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private dirty = false;
  private readonly pointers = new Map<number, Point>();
  private pinch = { ready: false, distance: 0 };

  constructor(host: HTMLElement, options: ChartPanelOptions) {
    this.options = options;
    this.spec = chartSpec(options.mode);
    this.state = this.load(options.source);

    this.root = h("div", { cls: "mtk-editor mtk-chart-editor" });
    this.root.tabIndex = 0;

    const header = this.buildHeader();
    const toolbar = this.buildToolbar();
    this.buildBody();

    // Assembled in one place, in one order. Each builder returns its element and
    // appends nothing: three builders that each had to remember to attach
    // themselves in the right sequence is a contract nobody can see, and the
    // earlier version of this line — `insertBefore(toolbar, this.bodyWrap)` —
    // threw on construction because `bodyWrap` had never been attached at all.
    // Three rows, no hint strip: the gesture list that used to sit under the
    // canvas repeated what the toolbar and the property panel already say, and
    // it cost a row of drawing. This was the last panel rendering one, so
    // `.mtk-hints` and every `chart.hint.*` string went with it.
    this.root.append(header, toolbar, this.bodyWrap);

    this.bindCanvas();
    this.bindKeyboard();

    // Attached *before* the first paint. `readPalette` resolves the `--mtk-*`
    // custom properties from the SVG, and the dark overrides are scoped
    // `.theme-dark .mtk-editor` — a selector that cannot match a detached tree.
    // Painting off-document therefore resolves the light values and keeps them:
    // every SVG paint is baked in as an attribute, so a dark-theme user got a
    // light drawing with nothing to repaint it. Measured, not theorised —
    // `tools/harness/probe.mjs` reports `paintedShape` per theme.
    host.appendChild(this.root);
    this.repaint();
    this.renderProps();

    if (Platform.isMobile) new Notice(t("notice.mobileTip"));
  }

  /* ------------------------------------------------------------- lifecycle */

  attach(host: HTMLElement): void {
    host.appendChild(this.root);
    // The container just changed size; repaint with the real width first so
    // width-dependent specs (e.g. the gantt chart's dayW) recompute, then fit
    // again on the next frame. Skipping the repaint left stale dimensions and
    // caused the gantt chart to open zoomed to maxScale (e.g. 300%).
    window.setTimeout(() => {
      this.repaint();
      this.fit();
    }, 0);
  }

  destroy(): void {
    this.root.remove();
  }

  getSource(): string {
    return this.spec.serialize(this.state);
  }

  get hasChanges(): boolean {
    return this.dirty;
  }

  /** SVG paints are baked-in attributes, so a theme change needs a re-render. */
  repaintForTheme(): void {
    this.repaint();
  }

  /* ---------------------------------------------------------------- chrome */

  private buildButton(cls: string, label: string, icon?: string): HTMLButtonElement {
    const button = h("button", { cls: `mtk-tb ${cls}` });
    button.type = "button";
    if (icon) {
      const glyph = h("span", { cls: "mtk-tb-icon" });
      setIcon(glyph, icon);
      button.appendChild(glyph);
    }
    if (label) button.appendChild(h("span", { cls: "mtk-tb-label", text: label }));
    applyTooltip(button, label);
    return button;
  }

  private buildHeader(): HTMLElement {
    const kind = kindById(this.options.mode);
    const header = h("div", { cls: "mtk-header" });
    header.appendChild(h("span", { cls: "mtk-title", text: t("chart.title", { kind: t(kind.nameKey) }) }));
    // The badge names the fence keyword, which is what actually sits in the
    // file and what someone searching the note will find.
    header.appendChild(h("span", { cls: "mtk-mode", text: kind.keyword }));
    // No buttons here, matching the mind-map panel: saving leads the toolbar
    // below, and a dialog is closed by Obsidian's own affordances — the
    // `modal-close-button` the base `Modal` class builds, Escape, or a click on
    // the backdrop. A tab is closed from its tab header.
    return header;
  }

  private buildToolbar(): HTMLElement {
    const toolbar = h("div", { cls: "mtk-toolbar" });

    // Saving leads the toolbar, exactly as in the mind-map panel: the header no
    // longer carries buttons, so this is the one visible save control. It reuses
    // the `mtk-save` class, which is what `.mtk-editor .mtk-tb.mtk-save` keys the
    // accent fill off — the class is a style hook first and a name second.
    const save = this.buildButton("mtk-save", t("editor.save"), "save");
    save.addEventListener("click", () => void this.save());
    toolbar.appendChild(save);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    // Same button as the mind-map panel's, in the same slot: one group of
    // whole-chart actions between save and history. It shares that panel's
    // `mtk-tidy` class on purpose — no rule keys off it, and the two buttons
    // are meant to read as the same control in two windows.
    const tidy = this.buildButton("mtk-tidy", t("editor.toolbar.layout"), "network");
    tidy.addEventListener("click", () => this.tidy());
    toolbar.appendChild(tidy);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    const undo = this.buildButton("mtk-chart-undo", t("editor.toolbar.undo"), "undo-2");
    undo.addEventListener("click", () => this.undo());
    const redo = this.buildButton("mtk-chart-redo", t("editor.toolbar.redo"), "redo-2");
    redo.addEventListener("click", () => this.redo());
    toolbar.append(undo, redo);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    const add = this.buildButton("mtk-chart-add", t("chart.add"), "plus");
    add.addEventListener("click", () => this.addOne());
    const remove = this.buildButton("mtk-chart-delete", t("editor.toolbar.delete"), "trash-2");
    remove.addEventListener("click", () => this.deleteSelected());
    toolbar.append(add, remove);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    const zoomOut = this.buildButton("mtk-chart-zoom-out", t("editor.toolbar.zoomOut"), "zoom-out");
    zoomOut.addEventListener("click", () => this.zoomBy(1 / 1.15));
    this.zoomLabel = h("span", { cls: "mtk-zoom-value", text: "100%" });
    const zoomIn = this.buildButton("mtk-chart-zoom-in", t("editor.toolbar.zoomIn"), "zoom-in");
    zoomIn.addEventListener("click", () => this.zoomBy(1.15));
    const fit = this.buildButton("mtk-chart-fit", t("editor.toolbar.fit"), "scan");
    fit.addEventListener("click", () => this.fit());
    toolbar.append(zoomOut, this.zoomLabel, zoomIn, fit);
    toolbar.appendChild(h("div", { cls: "mtk-divider" }));

    toolbar.appendChild(h("span", { cls: "mtk-spacer" }));
    this.statusLabel = h("span", { cls: "mtk-status", text: t("editor.selectedNone") });
    toolbar.appendChild(this.statusLabel);
    return toolbar;
  }

  private buildBody(): void {
    this.bodyWrap = h("div", { cls: "mtk-chart-body" });

    this.canvasWrap = h("div", { cls: "mtk-canvas" });
    this.canvasWrap.appendChild(h("div", { cls: "mtk-grid" }));
    this.surface = createSurface(this.canvasWrap);
    this.svg = this.surface.svg;
    this.emptyNote = h("div", { cls: "mtk-empty", text: t("chart.empty") });
    this.canvasWrap.appendChild(this.emptyNote);

    // State/ER diagrams and the gantt chart are edited through the right-click
    // menu too (matching sequence and class), so the canvas keeps the whole body.
    // The other four chart kinds still render the property panel.
    if (
      this.options.mode === "sequence" ||
      this.options.mode === "class" ||
      this.options.mode === "state" ||
      this.options.mode === "er" ||
      this.options.mode === "gantt" ||
      this.options.mode === "pie"
    ) {
      this.bodyWrap.append(this.canvasWrap);
      return;
    }

    this.propsEl = h("aside", { cls: "mtk-props" });
    this.bodyWrap.append(this.canvasWrap, this.propsEl);
  }

  /* --------------------------------------------------------------- loading */

  /** Parse, then lay out — `parse` leaves every coordinate at zero. */
  private load(source: string): unknown {
    const state = this.spec.parse(source);
    this.spec.layout(state);
    return state;
  }

  /* --------------------------------------------------------------- drawing */

  private repaint(): void {
    this.handles.clear();
    paintChart(this.surface, this.spec, this.state, {
      palette: readPalette(this.svg),
      selected: this.selected,
      interactive: true,
      grips: this.handles,
      // The surface width so a width-aware spec (the gantt) can spread to fill
      // the column; `fit()` later reads the resulting bounds and frames it.
      width: this.canvasWrap.clientWidth,
    });
    this.applyViewTransform();
    this.updateChrome();
  }

  private applyViewTransform(): void {
    this.surface.layer.setAttribute(
      "transform",
      `translate(${this.view.tx},${this.view.ty}) scale(${this.view.k})`
    );
    // Single writer for the zoom readout, same rule as the node editor: two
    // writers is how a button ends up moving the canvas while the number stays.
    this.zoomLabel.textContent = `${Math.round(this.view.k * 100)}%`;
  }

  private updateChrome(): void {
    const summary = this.spec.summary(this.state);
    this.statusLabel.textContent =
      summary.edges > 0
        ? t("chart.summaryBoth", { nodes: summary.nodes, edges: summary.edges })
        : t("chart.summaryOne", { nodes: summary.nodes });

    const remove = this.root.querySelector<HTMLButtonElement>(".mtk-chart-delete");
    if (remove) remove.disabled = !this.selected;
    const undo = this.root.querySelector<HTMLButtonElement>(".mtk-chart-undo");
    if (undo) undo.disabled = this.undoStack.length === 0;
    const redo = this.root.querySelector<HTMLButtonElement>(".mtk-chart-redo");
    if (redo) redo.disabled = this.redoStack.length === 0;

    this.emptyNote.classList.toggle("is-visible", this.spec.extent(this.state) === null);
  }

  /**
   * The property panel, rebuilt from whatever the spec declares for the current
   * selection. The panel knows six field kinds and nothing about diagrams.
   */
  private renderProps(): void {
    // State/ER diagrams and the gantt chart have no side panel either; their
    // editing lives in the right-click menu (and the task dialog opened from it).
    if (
      this.options.mode === "sequence" ||
      this.options.mode === "class" ||
      this.options.mode === "state" ||
      this.options.mode === "er" ||
      this.options.mode === "gantt" ||
      this.options.mode === "pie" ||
      !this.propsEl
    )
      return;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(h("div", { cls: "mtk-props-head", text: t("chart.props.title") }));

    const fields = this.spec.panel(this.state, this.selected);
    if (!fields.length) {
      fragment.appendChild(h("div", { cls: "mtk-prop-note", text: t("chart.props.none") }));
    }
    for (const field of fields) fragment.appendChild(this.buildField(field));
    this.propsEl.replaceChildren(fragment);
  }

  private buildField(field: ChartField): HTMLElement {
    switch (field.kind) {
      case "note":
        return h("div", { cls: "mtk-prop-note", text: field.text });
      case "button":
        return this.buildPropButton(field);
      case "text": {
        const input = h("input", { cls: "mtk-prop-input" });
        input.type = "text";
        input.value = field.value;
        input.spellcheck = false;
        if (field.placeholder) input.placeholder = field.placeholder;
        this.bindField(input, () => field.apply(input.value));
        return this.wrapField(field.label, input);
      }
      case "rows": {
        const area = h("textarea", { cls: "mtk-prop-input mtk-prop-area" });
        area.value = field.value.join("\n");
        area.rows = Math.min(9, Math.max(2, field.value.length + 1));
        if (field.placeholder) area.placeholder = field.placeholder;
        // One entry per line is the only shape a textarea can offer, and it is
        // also how every list in the syntax is written.
        this.bindField(area, () => {
          field.apply(
            area.value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          );
        });
        return this.wrapField(field.label, area);
      }
      case "number": {
        const input = h("input", { cls: "mtk-prop-input" });
        input.type = "number";
        input.value = String(field.value);
        input.step = String(field.step ?? 1);
        if (field.min !== undefined) input.min = String(field.min);
        this.bindField(input, () => {
          const parsed = Number(input.value);
          if (!Number.isFinite(parsed)) return;
          field.apply(field.min !== undefined ? Math.max(field.min, parsed) : parsed);
        });
        return this.wrapField(field.label, input);
      }
      case "select": {
        const select = h("select", { cls: "mtk-prop-input mtk-prop-select" });
        for (const option of field.options) {
          const node = h("option", { text: option.label });
          node.value = option.value;
          select.appendChild(node);
        }
        select.value = field.value;
        this.bindField(select, () => field.apply(select.value));
        return this.wrapField(field.label, select);
      }
    }
  }

  private wrapField(label: string, control: HTMLElement): HTMLElement {
    const wrap = h("label", { cls: "mtk-prop" });
    wrap.appendChild(h("span", { cls: "mtk-prop-label", text: label }));
    wrap.appendChild(control);
    return wrap;
  }

  /**
   * Wires the three events every editable field shares.
   *
   * `input` repaints live but rebuilds nothing — rebuilding the panel mid-edit
   * would take the caret away from the field being typed into. `change` is the
   * commit: by then the field has lost focus, so a rebuild is safe and the
   * snapshot taken on focus becomes one undo step for the whole edit.
   */
  private bindField(el: HTMLElement, apply: () => void): void {
    el.addEventListener("focus", () => {
      this.fieldUndo = this.spec.serialize(this.state);
    });
    el.addEventListener("input", () => {
      apply();
      this.spec.layout(this.state);
      this.repaint();
    });
    el.addEventListener("change", () => {
      const before = this.fieldUndo;
      this.fieldUndo = null;
      apply();
      if (before) this.pushUndoIfChanged(before);
      this.commit(true);
    });
  }

  private buildPropButton(field: Extract<ChartField, { kind: "button" }>): HTMLElement {
    const button = h("button", { cls: "mtk-prop-btn" });
    button.type = "button";
    if (field.icon) {
      const glyph = h("span", { cls: "mtk-tb-icon" });
      setIcon(glyph, field.icon);
      button.appendChild(glyph);
    }
    button.appendChild(h("span", { cls: "mtk-tb-label", text: field.label }));
    applyTooltip(button, field.label);
    button.addEventListener("click", () => {
      const before = this.spec.serialize(this.state);
      const next = field.apply();
      // Returning an id is how "add a state" leaves the new state open in the
      // panel instead of making the user find it on the canvas.
      if (typeof next === "string") this.selected = next;
      this.pushUndoIfChanged(before);
      this.commit(true);
    });
    return button;
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
    const bounds = this.spec.extent(this.state);
    if (!bounds) {
      this.view = { k: 1, tx: width / 2, ty: height / 2 };
      this.applyViewTransform();
      return;
    }
    this.view = fitBounds(bounds, width, height, {
      padding: Platform.isMobile ? 22 : 34,
      // A spec may ask to fill more of the canvas than the generic cap allows
      // (the gantt does — an empty margin either side reads as a broken axis).
      maxScale: this.spec.fit?.maxScale ?? (Platform.isMobile ? 1 : 1.15),
      anchorLeft: Platform.isMobile,
    });
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

  /**
   * Pushes `before` only when the state has actually moved on from it.
   *
   * Called *after* the mutation rather than before, which is what makes the
   * comparison possible: a gesture that ends where it started — a drag returned
   * to its origin, a "cancel link" button — leaves the undo stack untouched
   * instead of adding a step that appears to do nothing.
   */
  private pushUndoIfChanged(before: string): boolean {
    const after = this.spec.serialize(this.state);
    if (after === before) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
    return true;
  }

  private commit(relayout: boolean): void {
    if (relayout) this.spec.layout(this.state);
    this.repaint();
    this.renderProps();
  }

  private restore(source: string): void {
    this.state = this.load(source);
    this.selected = null;
    this.commit(false);
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.spec.serialize(this.state));
    this.restore(previous);
    this.dirty = true;
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.spec.serialize(this.state));
    this.restore(next);
    this.dirty = true;
  }

  private addOne(): void {
    const before = this.spec.serialize(this.state);
    this.selected = this.spec.add(this.state);
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    const before = this.spec.serialize(this.state);
    // The gantt's grip ids carry a `bar:`/`rz:` prefix; the spec's `remove`
    // wants the bare task id, so strip it. Other chart kinds never use those
    // prefixes, so this is a no-op for them and the toolbar Delete stays
    // consistent across every chart.
    this.spec.remove(this.state, this.bareId(this.selected));
    this.selected = null;
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  /** Strips the gantt grip prefixes (`bar:`/`rz:`) from a hit id; returns the id
   * untouched for every other chart kind. */
  private bareId(id: string): string {
    return id.startsWith("bar:") ? id.slice(4) : id.startsWith("rz:") ? id.slice(3) : id;
  }

  /**
   * Drops every hand-placed element and puts the chart back on its computed
   * layout.
   *
   * Four specs keep geometry the source text does not carry — a class box, an
   * ER entity and a state node hold `pinned`, a gantt bar holds `manual` — and
   * those flags are what make a drag stick. Releasing them is the spec's job
   * (`spec.tidy`); the relayout, the repaint and the re-fit are this panel's.
   * The five specs with nothing to release omit the hook and just get the
   * relayout, which is the honest answer: their canvas is never off-grid.
   *
   * Undo records the gesture only when the *text* moved, which is why tidying
   * a class diagram leaves the stack alone — a pin is invisible to `serialize`,
   * so there is no earlier state for an undo step to return to.
   */
  private tidy(): void {
    const before = this.spec.serialize(this.state);
    this.spec.tidy?.(this.state);
    this.pushUndoIfChanged(before);
    this.commit(true);
    this.fit();
    new Notice(t("notice.layoutDone"));
  }

  /* ------------------------------------------------------------- keyboard */

  private bindKeyboard(): void {
    this.root.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      const tag = (target?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

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
      if ((event.key === "Delete" || event.key === "Backspace") && this.selected) {
        this.deleteSelected();
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" && this.selected) {
        this.selected = null;
        this.commit(false);
        event.preventDefault();
      }
    });
  }

  /* ------------------------------------------------------------ pointer io */

  private bindCanvas(): void {
    const svg = this.svg;

    svg.addEventListener("pointerdown", (event) => {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.root.focus();
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (this.pointers.size > 1) {
        this.drag = null;
        return;
      }

      this.moved = false;
      this.pendingUndo = null;
      this.hitId = this.elementIdFromEvent(event);
      const handle = this.hitId ? this.handles.get(this.hitId) ?? null : null;

      if (handle && handle.axis !== "none") {
        this.drag = {
          kind: "grip",
          handle,
          origin: handle.begin(),
          startX: event.clientX,
          startY: event.clientY,
        };
      } else if (!this.hitId) {
        this.drag = {
          kind: "pan",
          startX: event.clientX,
          startY: event.clientY,
          originTx: this.view.tx,
          originTy: this.view.ty,
        };
        this.canvasWrap.classList.add("is-panning");
      } else {
        // Pressed on something that is not draggable. Not a pan: panning out
        // from under a shape the user was aiming at feels broken.
        this.drag = null;
      }
      this.capture(event);
      event.preventDefault();
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

      const drag = this.drag;
      if (!drag) return;
      if (!this.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= CLICK_SLOP) return;
        this.moved = true;
        if (drag.kind === "grip") this.pendingUndo = this.spec.serialize(this.state);
      }

      if (drag.kind === "pan") {
        this.view.tx = drag.originTx + (event.clientX - drag.startX);
        this.view.ty = drag.originTy + (event.clientY - drag.startY);
        this.applyViewTransform();
        return;
      }

      const rawX = (event.clientX - drag.startX) / this.view.k;
      const rawY = (event.clientY - drag.startY) / this.view.k;
      drag.handle.drag(
        drag.handle.axis === "y" ? 0 : rawX,
        drag.handle.axis === "x" ? 0 : rawY,
        drag.origin
      );
      // No relayout while dragging: the spec is moving coordinates itself, and
      // a layout pass mid-drag would snap the thing being dragged.
      this.repaint();
    });

    const finish = (event: PointerEvent): void => {
      const cancelled = event.type === "pointercancel";
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) {
        this.pinch.ready = false;
        this.pinch.distance = 0;
      }
      const drag = this.drag;
      const hitId = this.hitId;
      const moved = this.moved;
      const pending = this.pendingUndo;
      this.drag = null;
      this.hitId = null;
      this.moved = false;
      this.pendingUndo = null;
      this.canvasWrap.classList.remove("is-panning");

      if (moved) {
        // A real drag: one undo step covering the whole gesture, taken from
        // before its first pixel. Panning moves the viewport, not the chart,
        // so it has nothing to record.
        if (drag?.kind === "grip") {
          if (pending !== null) this.pushUndoIfChanged(pending);
          this.commit(false);
        }
        return;
      }
      if (cancelled) return;

      // A press that did not move is a click. A double-click is two of these,
      // which is why the spec's click hooks have to be safe to run twice rather
      // than the panel wiring anything to `dblclick`.
      const point = this.toModelCoords(event.clientX, event.clientY);
      const before = this.spec.serialize(this.state);
      if (hitId) {
        // State/ER: drawing a transition/relation finishes on a left-click and
        // the new edge is what the spec's onPick just appended, so snapshot the
        // edge ids beforehand to find it and open its editor right away.
        const beforeEdgeIds =
          this.options.mode === "state" || this.options.mode === "er"
            ? new Set((this.state as StateChartShape | ErChartShape).edges.map((edge) => edge.id))
            : null;
        if (this.spec.onPick?.(this.state, hitId, point)) {
          this.pushUndoIfChanged(before);
          if (beforeEdgeIds) {
            if (this.options.mode === "state") {
              const edge = (this.state as StateChartShape).edges.find((e) => !beforeEdgeIds.has(e.id));
              if (edge) this.openStateTransitionDialog(edge);
            } else {
              const edge = (this.state as ErChartShape).edges.find((e) => !beforeEdgeIds.has(e.id));
              if (edge) this.openErRelationDialog(edge);
            }
          }
          this.commit(true);
          return;
        }
        this.selected = hitId;
        this.commit(false);
        return;
      }
      const created = this.spec.onClick?.(this.state, point) ?? null;
      this.selected = created;
      this.pushUndoIfChanged(before);
      this.commit(created !== null);
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);

    svg.addEventListener("dblclick", (event) => {
      // Two clicks have already reached `onClick`, so on a chart where a click
      // is itself the edit (a git graph drops a commit where you click) a
      // double-click must not also add one.
      if (this.spec.onClick || this.elementIdFromEvent(event)) return;
      const point = this.toModelCoords(event.clientX, event.clientY);
      const before = this.spec.serialize(this.state);
      const created = this.spec.onDoubleClick?.(this.state, point) ?? this.spec.add(this.state);
      this.selected = created;
      this.pushUndoIfChanged(before);
      this.commit(true);
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

    // Sequence, class, state, ER diagrams and the gantt chart drive all editing
    // from the right-click menu; the other four chart kinds keep their
    // left-click-to-select + side-panel.
    svg.addEventListener("contextmenu", (event: MouseEvent) => {
      if (
        this.options.mode !== "sequence" &&
        this.options.mode !== "class" &&
        this.options.mode !== "state" &&
        this.options.mode !== "er" &&
        this.options.mode !== "gantt" &&
        this.options.mode !== "pie"
      )
        return;
      event.preventDefault();
      if (this.options.mode === "sequence") this.openSequenceMenu(event);
      else if (this.options.mode === "class") this.openClassMenu(event);
      else if (this.options.mode === "state") this.openStateMenu(event);
      else if (this.options.mode === "er") this.openErMenu(event);
      else if (this.options.mode === "pie") this.openPieMenu(event);
      else this.openGanttMenu(event);
    });
  }

  private capture(event: PointerEvent): void {
    try {
      this.svg.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer capture is a nicety; dragging still works without it. */
    }
  }

  private elementIdFromEvent(event: Event): string | null {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest("[data-mtk]")?.getAttribute("data-mtk") ?? null;
  }

  /* --------------------------------------------------- sequence context menu */

  /**
   * Right-click menu for the sequence diagram. The side panel is gone for this
   * chart, so every edit — add participant, add/edit/delete message, rename
   * participant — is reached from here.
   */
  private openSequenceMenu(event: MouseEvent): void {
    const chart = this.state as SequenceChartShape;
    const hitId = this.elementIdFromEvent(event);
    const menu = new Menu();

    if (!hitId) {
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.addParticipant")).setIcon("plus").onClick(() => this.addParticipantToCanvas())
      );
      if (chart.actors.length > 0) {
        menu.addItem((item) =>
          item.setTitle(t("chart.seq.addMessage")).setIcon("message-square-plus").onClick(() => this.openMessageDialog(null))
        );
      }
    } else if (chart.actors.some((a) => a.id === hitId)) {
      const actor = chart.actors.find((a) => a.id === hitId);
      if (!actor) return;
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.rename")).setIcon("pencil").onClick(() => this.renameActor(actor))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.addMessage")).setIcon("message-square-plus").onClick(() => this.openMessageDialog(null, actor.id))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.deleteParticipant")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
    } else if (chart.messages.some((m) => m.id === hitId)) {
      const message = chart.messages.find((m) => m.id === hitId);
      if (!message) return;
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.editMessage")).setIcon("pencil").onClick(() => this.openMessageDialog(message))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.seq.deleteMessage")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
    }

    menu.showAtMouseEvent(event);
  }

  private addParticipantToCanvas(): void {
    const before = this.spec.serialize(this.state);
    this.selected = this.spec.add(this.state);
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private deleteById(id: string): void {
    const before = this.spec.serialize(this.state);
    this.spec.remove(this.state, id);
    if (this.selected === id) this.selected = null;
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private renameActor(actor: SequenceActor): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.seq.renameTitle"),
      "",
      [{ key: "label", label: t("chart.seq.label"), value: actor.label }],
      t("chart.seq.renameOk"),
      (values) => {
        const next = values.label.trim();
        if (!next) return t("chart.seq.nameRequired");
        const before = this.spec.serialize(this.state);
        actor.label = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  /**
   * Opens the message editor. Pass an existing message to edit it, or `null`
   * (optionally with a `fromHint`) to create a new one. The dialog owns the
   * form; on confirm it writes the fields back and commits a single undo step.
   */
  private openMessageDialog(existing: SequenceMessage | null, fromHint?: string): void {
    const chart = this.state as SequenceChartShape;
    if (chart.actors.length === 0) {
      // No participant to send from: drop one on the canvas first, then let the
      // user add the message on the next right-click.
      this.addParticipantToCanvas();
      return;
    }
    const actorOptions = chart.actors.map((a) => ({ value: a.id, label: a.label }));
    const init = existing
      ? { from: existing.from, to: existing.to, arrow: existing.arrow, text: existing.text }
      : this.defaultMessage(chart, fromHint);
    const dialog = new MessageDialog(this.options.app, actorOptions, init, (values) => {
      const before = this.spec.serialize(this.state);
      if (existing) {
        existing.from = values.from;
        existing.to = values.to;
        existing.arrow = values.arrow;
        existing.text = values.text;
      } else {
        const id = nextId(
          chart.messages.map((m) => m.id),
          "m"
        );
        chart.messages.push({ id, from: values.from, to: values.to, text: values.text, arrow: values.arrow, y: 0 });
        this.selected = id;
      }
      this.pushUndoIfChanged(before);
      this.commit(true);
    });
    dialog.open();
  }

  private defaultMessage(
    chart: SequenceChartShape,
    fromHint?: string
  ): { from: string; to: string; arrow: string; text: string } {
    const fromIndex = chart.actors.findIndex((a) => a.id === fromHint);
    const from = chart.actors[fromIndex >= 0 ? fromIndex : 0];
    const toIndex = (fromIndex >= 0 ? fromIndex + 1 : 1) % chart.actors.length;
    const to = chart.actors[toIndex] ?? from;
    return { from: from.id, to: to.id, arrow: "->>", text: "" };
  }

  /* ----------------------------------------------------- class context menu */

  /**
   * Right-click menu for class diagrams. The side panel is gone for this chart,
   * so every edit — add/rename class, edit attributes/methods, add/edit/delete
   * relation, release a pinned box, delete — is reached from here.
   *
   * Adding a relation walks through the spec's own `linking` state: "Add
   * relation" arms it on the source class, a follow-up right-click on a *target*
   * class opens a relation-type submenu, and picking one creates the edge. A
   * left-click on the target still works too (it just uses the default `-->`).
   */
  private openClassMenu(event: MouseEvent): void {
    const chart = this.state as ClassChartShape;
    const hitId = this.elementIdFromEvent(event);
    const menu = new Menu();

    // While a relation is being drawn, only another class can be the target.
    if (chart.linking) {
      const validTarget =
        hitId && hitId !== chart.linking && chart.items.some((i) => i.id === hitId);
      if (!validTarget) {
        menu.addItem((item) =>
          item
            .setTitle(t("chart.class.cancelLink"))
            .setIcon("x")
            .onClick(() => this.cancelLink())
        );
        menu.showAtMouseEvent(event);
        return;
      }
      const sourceId = chart.linking;
      for (const entry of RELATION_GROUPS) {
        menu.addItem((item) =>
          item
            .setTitle(t(entry.labelKey))
            .setIcon("corner-down-right")
            .onClick(() => this.addClassEdge(sourceId, hitId, entry.op))
        );
      }
      menu.showAtMouseEvent(event);
      return;
    }

    if (!hitId) {
      menu.addItem((item) =>
        item.setTitle(t("chart.class.addClass")).setIcon("plus").onClick(() => this.addOne())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const item = chart.items.find((i) => i.id === hitId);
    if (item) {
      menu.addItem((mi) =>
        mi.setTitle(t("chart.class.editName")).setIcon("pencil").onClick(() => this.renameClass(item))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.class.editAttrs")).setIcon("list").onClick(() => this.editMembers(item, "attrs"))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.class.editMethods")).setIcon("function-square").onClick(() => this.editMembers(item, "methods"))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.class.addRelation")).setIcon("corner-down-right").onClick(() => this.startLink(item))
      );
      if (item.pinned) {
        menu.addItem((mi) =>
          mi.setTitle(t("chart.release")).setIcon("move").onClick(() => this.releaseItem(item))
        );
      }
      menu.addItem((mi) =>
        mi.setTitle(t("chart.deleteClass")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const edge = chart.edges.find((e) => e.id === hitId);
    if (edge) {
      menu.addItem((item) =>
        item.setTitle(t("chart.class.editRelation")).setIcon("pencil").onClick(() => this.openRelationDialog(edge))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.deleteRelation")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
    }
  }

  private cancelLink(): void {
    const chart = this.state as ClassChartShape;
    chart.linking = null;
    this.commit(false);
  }

  private startLink(item: ClassItemShape): void {
    const chart = this.state as ClassChartShape;
    chart.linking = item.id;
    this.commit(false);
    new Notice(t("chart.class.pickTarget", { name: item.name }));
  }

  private addClassEdge(fromId: string, toId: string | null, op: string): void {
    if (!toId) return;
    const chart = this.state as ClassChartShape;
    const before = this.spec.serialize(this.state);
    chart.edges.push({
      id: nextId(chart.edges.map((e) => e.id), "r"),
      from: fromId,
      to: toId,
      op,
      label: "",
    });
    chart.linking = null;
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private renameClass(item: ClassItemShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.class.renameTitle"),
      "",
      [{ key: "name", label: t("chart.class.name"), value: item.name }],
      t("chart.class.confirm"),
      (values) => {
        const next = values.name.trim();
        if (!next) return t("chart.class.nameRequired");
        const before = this.spec.serialize(this.state);
        item.name = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  private releaseItem(item: { pinned?: boolean }): void {
    const before = this.spec.serialize(this.state);
    item.pinned = false;
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private editMembers(item: ClassItemShape, kind: "attrs" | "methods"): void {
    const title = kind === "attrs" ? t("chart.class.attrTitle") : t("chart.class.methodTitle");
    const lines = kind === "attrs" ? item.attrs : item.methods;
    const dialog = new ClassMemberDialog(
      this.options.app,
      title,
      lines.join("\n"),
      kind === "attrs" ? t("chart.class.attrPlaceholder") : t("chart.class.methodPlaceholder"),
      (value) => {
        const next = value
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const before = this.spec.serialize(this.state);
        if (kind === "attrs") item.attrs = next;
        else item.methods = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
      }
    );
    dialog.open();
  }

  private openRelationDialog(edge: ClassEdgeShape): void {
    const chart = this.state as ClassChartShape;
    const fromName = chart.items.find((i) => i.id === edge.from)?.name ?? "?";
    const toName = chart.items.find((i) => i.id === edge.to)?.name ?? "?";
    const dialog = new RelationDialog(
      this.options.app,
      RELATION_GROUPS.map((entry) => ({ value: entry.op, label: t(entry.labelKey) })),
      { op: edge.op, role: edge.label, from: fromName, to: toName },
      (values) => {
        const before = this.spec.serialize(this.state);
        edge.op = values.op;
        edge.label = values.role;
        this.pushUndoIfChanged(before);
        this.commit(true);
      }
    );
    dialog.open();
  }

  /* --------------------------------------------------------- state context menu */

  /**
   * Right-click menu for the state diagram. Like the class diagram, the side
   * panel is gone, so every edit — add/rename/delete a state, draw/edit/delete
   * a transition — is reached from here. `[*]` markers are derived and never
   * appear in the menu.
   */
  private openStateMenu(event: MouseEvent): void {
    const chart = this.state as StateChartShape;
    const hitId = this.elementIdFromEvent(event);
    const menu = new Menu();

    // While a transition is being drawn, a left-click on another state
    // completes it; the right-click menu only offers to cancel.
    if (chart.linking) {
      menu.addItem((item) =>
        item.setTitle(t("chart.cancel")).setIcon("x").onClick(() => this.cancelLink())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    if (!hitId) {
      menu.addItem((item) =>
        item.setTitle(t("chart.state.addState")).setIcon("plus").onClick(() => this.addNode())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const item = chart.items.find((i) => i.id === hitId);
    if (item) {
      if (item.virtual) return; // [*] markers are derived, not editable
      menu.addItem((mi) =>
        mi.setTitle(t("chart.state.editName")).setIcon("pencil").onClick(() => this.renameState(item))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.state.addTransition")).setIcon("corner-down-right").onClick(() => this.startNodeLink(item))
      );
      if (item.pinned) {
        menu.addItem((mi) =>
          mi.setTitle(t("chart.release")).setIcon("move").onClick(() => this.releaseItem(item))
        );
      }
      menu.addItem((mi) =>
        mi.setTitle(t("chart.deleteState")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const edge = chart.edges.find((e) => e.id === hitId);
    if (edge) {
      menu.addItem((item) =>
        item.setTitle(t("chart.state.editTransition")).setIcon("pencil").onClick(() => this.openStateTransitionDialog(edge))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.deleteTransition")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
    }
  }

  private renameState(item: StateItemShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.state.editName"),
      "",
      [{ key: "name", label: t("chart.state.name"), value: item.name }],
      t("chart.class.confirm"),
      (values) => {
        const next = values.name.trim();
        if (!next) return t("chart.class.nameRequired");
        const before = this.spec.serialize(this.state);
        item.name = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  private openStateTransitionDialog(edge: StateEdgeShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.state.editTransition"),
      "",
      [{ key: "event", label: t("chart.state.event"), value: edge.label }],
      t("chart.class.confirm"),
      (values) => {
        const before = this.spec.serialize(this.state);
        edge.label = values.event.trim();
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  /* ----------------------------------------------------------- er context menu */

  /**
   * Right-click menu for the ER diagram. Same shape as the state/class menus:
   * add/rename/delete an entity, edit its fields, draw/edit/delete a relation.
   * A relation is drawn by right-clicking the source entity, then left-clicking
   * the target — which pops the relation editor so the cardinalities are set.
   */
  private openErMenu(event: MouseEvent): void {
    const chart = this.state as ErChartShape;
    const hitId = this.elementIdFromEvent(event);
    const menu = new Menu();

    // While a relation is being drawn, a left-click on another entity completes
    // it; the right-click menu only offers to cancel.
    if (chart.linking) {
      menu.addItem((item) =>
        item.setTitle(t("chart.cancel")).setIcon("x").onClick(() => this.cancelLink())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    if (!hitId) {
      menu.addItem((item) =>
        item.setTitle(t("chart.er.addEntity")).setIcon("plus").onClick(() => this.addNode())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const item = chart.items.find((i) => i.id === hitId);
    if (item) {
      menu.addItem((mi) =>
        mi.setTitle(t("chart.er.editName")).setIcon("pencil").onClick(() => this.renameEntity(item))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.er.editFields")).setIcon("list").onClick(() => this.editEntityFields(item))
      );
      menu.addItem((mi) =>
        mi.setTitle(t("chart.er.addRelation")).setIcon("corner-down-right").onClick(() => this.startNodeLink(item))
      );
      if (item.pinned) {
        menu.addItem((mi) =>
          mi.setTitle(t("chart.release")).setIcon("move").onClick(() => this.releaseItem(item))
        );
      }
      menu.addItem((mi) =>
        mi.setTitle(t("chart.deleteEntity")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
      return;
    }

    const edge = chart.edges.find((e) => e.id === hitId);
    if (edge) {
      menu.addItem((item) =>
        item.setTitle(t("chart.er.editRelation")).setIcon("pencil").onClick(() => this.openErRelationDialog(edge))
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.deleteRelation")).setIcon("trash-2").onClick(() => this.deleteById(hitId))
      );
      menu.showAtMouseEvent(event);
    }
  }

  /** Adds a state or an entity — `spec.add` is mode-specific, so one wrapper
   * covers both right-click "add" entries. */
  private addNode(): void {
    const before = this.spec.serialize(this.state);
    this.selected = this.spec.add(this.state);
    this.pushUndoIfChanged(before);
    this.commit(true);
  }

  private startNodeLink(item: StateItemShape | EntityItemShape): void {
    const chart = this.state as StateChartShape | ErChartShape;
    chart.linking = item.id;
    this.commit(false);
    const key = this.options.mode === "state" ? "chart.state.pickTarget" : "chart.er.pickTarget";
    new Notice(t(key, { name: item.name }));
  }

  private renameEntity(item: EntityItemShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.er.editName"),
      "",
      [{ key: "name", label: t("chart.er.name"), value: item.name }],
      t("chart.class.confirm"),
      (values) => {
        const next = values.name.trim();
        if (!next) return t("chart.class.nameRequired");
        const before = this.spec.serialize(this.state);
        item.name = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  private editEntityFields(item: EntityItemShape): void {
    const dialog = new ClassMemberDialog(
      this.options.app,
      t("chart.er.editFields"),
      item.fields.join("\n"),
      t("chart.er.fieldPlaceholder"),
      (value) => {
        const next = value
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const before = this.spec.serialize(this.state);
        item.fields = next;
        this.pushUndoIfChanged(before);
        this.commit(true);
      }
    );
    dialog.open();
  }

  private openErRelationDialog(edge: EntityEdgeShape): void {
    const chart = this.state as ErChartShape;
    const fromName = chart.items.find((i) => i.id === edge.from)?.name ?? "?";
    const toName = chart.items.find((i) => i.id === edge.to)?.name ?? "?";
    const dialog = new ErRelationDialog(
      this.options.app,
      CARD_OPTIONS.map((entry) => ({ value: entry.value, label: t(entry.key) })),
      {
        left: edge.left,
        right: edge.right,
        identifying: edge.identifying,
        label: edge.label,
        from: fromName,
        to: toName,
      },
      (values) => {
        const before = this.spec.serialize(this.state);
        edge.left = values.left;
        edge.right = values.right;
        edge.identifying = values.identifying;
        edge.label = values.label;
        this.pushUndoIfChanged(before);
        this.commit(true);
      }
    );
    dialog.open();
  }

  /* ----------------------------------------------------- gantt context menu */

  /**
   * Right-click menu for the gantt chart. Like the class/state/ER menus, the
   * side panel is gone, so every edit — add a task, edit a task, delete a task —
   * is reached from here. Dragging a bar (move) or its right edge (resize) stays
   * as before: the menu is for the fields a drag cannot reach (name, phase,
   * date, duration), and for removing a row.
   *
   * The grip ids carry a `bar:` / `rz:` prefix (the move/resize handles); the
   * real task id is what follows it, so it is stripped before the task lookup.
   */
  private openGanttMenu(event: MouseEvent): void {
    const chart = this.state as GanttChartShape;
    const rawId = this.elementIdFromEvent(event);
    const taskId = rawId ? this.bareId(rawId) : null;
    const task = taskId ? chart.tasks.find((t) => t.id === taskId) : null;
    const menu = new Menu();

    if (!task) {
      menu.addItem((item) =>
        item.setTitle(t("chart.gantt.addTask")).setIcon("plus").onClick(() => this.addOne())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    // Highlight the bar while its menu is open, matching how the other chart
    // menus focus the element they act on.
    this.selected = task.id;
    this.commit(false);

    menu.addItem((mi) =>
      mi.setTitle(t("chart.gantt.editTask")).setIcon("pencil").onClick(() => this.openGanttTaskDialog(task))
    );
    menu.addItem((mi) =>
      mi.setTitle(t("chart.deleteTask")).setIcon("trash-2").onClick(() => this.deleteById(task.id))
    );
    menu.showAtMouseEvent(event);
  }

  /**
   * The task editor. It carries the four fields the (removed) side panel offered
   * for a task — name, phase, start date, duration — but as a modal so the canvas
   * keeps its full width. Validation lives here and reports back inline (a bad
   * date or a sub-one duration leaves the dialog open with a message) so the
   * user is looking at the field that is wrong rather than a toast that fades.
   */
  private openGanttTaskDialog(task: GanttTaskShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.gantt.editTask"),
      "",
      [
        { key: "name", label: t("chart.gantt.name"), value: task.name },
        { key: "section", label: t("chart.gantt.section"), value: task.section },
        {
          key: "start",
          label: t("chart.gantt.start"),
          value: dayStr(task.start),
          hint: t("chart.gantt.formatHint"),
        },
        { key: "days", label: t("chart.gantt.days"), value: String(task.days) },
      ],
      t("chart.class.confirm"),
      (values) => {
        const name = values.name.trim();
        if (!name) return t("chart.gantt.nameRequired");
        const start = dayNum(values.start);
        if (start === null) return t("chart.gantt.invalidDate");
        const days = Number(values.days);
        if (!Number.isInteger(days) || days < 1) return t("chart.gantt.invalidDays");
        const before = this.spec.serialize(this.state);
        task.name = name;
        task.section = values.section.trim();
        task.start = start;
        task.days = days;
        task.manual = true;
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  /* --------------------------------------------------- pie context menu */

  /**
   * Right-click menu for the pie chart. The side panel is gone for this chart
   * too, so editing a slice — rename, change value, delete — and the title live
   * here, matching the gantt/sequence/class/state/er menus. The boundary grips
   * (`cut:n`) are untouched: those are drag interactions, not menu actions.
   */
  private openPieMenu(event: MouseEvent): void {
    const chart = this.state as PieChartShape;
    // Slice ids carry no prefix; grip ids do (`cut:n`), so ignore anything with a
    // colon — a right-click on a boundary falls through to the empty-area menu
    // (add slice / edit title), which is the sensible default there.
    const hitId = this.elementIdFromEvent(event);
    const slice = hitId && !hitId.includes(":") ? chart.slices.find((s) => s.id === hitId) : null;
    const menu = new Menu();

    if (!slice) {
      menu.addItem((item) =>
        item.setTitle(t("chart.pie.addSlice")).setIcon("plus").onClick(() => this.addOne())
      );
      menu.addItem((item) =>
        item.setTitle(t("chart.pie.editTitle")).setIcon("pencil").onClick(() => this.openPieTitleDialog())
      );
      menu.showAtMouseEvent(event);
      return;
    }

    // Highlight the slice while its menu is open, matching the other chart menus.
    this.selected = slice.id;
    this.commit(false);

    menu.addItem((mi) =>
      mi.setTitle(t("chart.pie.editSlice")).setIcon("pencil").onClick(() => this.openPieSliceDialog(slice))
    );
    menu.addItem((mi) =>
      mi.setTitle(t("chart.deleteSlice")).setIcon("trash-2").onClick(() => this.deleteById(slice.id))
    );
    menu.showAtMouseEvent(event);
  }

  private openPieSliceDialog(slice: PieSliceShape): void {
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.pie.editSlice"),
      "",
      [
        { key: "label", label: t("chart.pie.label"), value: slice.label },
        { key: "value", label: t("chart.pie.value"), value: String(slice.value) },
      ],
      t("chart.class.confirm"),
      (values) => {
        const label = values.label.trim();
        if (!label) return t("chart.pie.nameRequired");
        const value = Number(values.value);
        if (!Number.isFinite(value) || value <= 0) return t("chart.pie.invalidValue");
        const before = this.spec.serialize(this.state);
        slice.label = label;
        // Keep two decimals and never below the floor the spec enforces on write.
        slice.value = Math.max(0.5, Math.round(value * 100) / 100);
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  private openPieTitleDialog(): void {
    const chart = this.state as PieChartShape;
    const dialog = new TextToolModal(
      this.options.app,
      t("chart.pie.editTitle"),
      "",
      [{ key: "title", label: t("chart.pie.title"), value: chart.title }],
      t("chart.class.confirm"),
      (values) => {
        const before = this.spec.serialize(this.state);
        chart.title = values.title.trim();
        this.pushUndoIfChanged(before);
        this.commit(true);
        return null;
      }
    );
    dialog.open();
  }

  /* --------------------------------------------------------------- output */

  private async save(): Promise<void> {
    const source = this.getSource();
    this.dirty = false;
    await this.options.host.save(source);
  }

}

/**
 * The message editor dialog for sequence diagrams.
 *
 * It carries the four fields the (removed) side panel offered for a message —
 * sender, receiver, arrow style, text — but as a modal so the canvas keeps its
 * full width. Both "add message" and "edit message" flow through here; the
 * caller's `onSubmit` decides whether to append a new message or mutate an
 * existing one.
 */
class MessageDialog extends Modal {
  private readonly actorOptions: Array<{ value: string; label: string }>;
  private readonly initial: { from: string; to: string; arrow: string; text: string };
  private readonly onSubmit: (values: { from: string; to: string; arrow: string; text: string }) => void;

  constructor(
    app: App,
    actorOptions: Array<{ value: string; label: string }>,
    initial: { from: string; to: string; arrow: string; text: string },
    onSubmit: (values: { from: string; to: string; arrow: string; text: string }) => void
  ) {
    super(app);
    this.actorOptions = actorOptions;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: t("chart.seq.editMessage") }));

    const from = this.buildSelect(t("chart.seq.from"), this.initial.from, this.actorOptions);
    const to = this.buildSelect(t("chart.seq.to"), this.initial.to, this.actorOptions);
    const arrowOptions = [
      { value: "->>", label: t("chart.seq.solidArrow") },
      { value: "-->>", label: t("chart.seq.dashedArrow") },
      { value: "->", label: t("chart.seq.solidLine") },
      { value: "-->", label: t("chart.seq.dashedLine") },
      { value: "-x", label: t("chart.seq.solidCross") },
      { value: "--x", label: t("chart.seq.dashedCross") },
    ];
    const arrow = this.buildSelect(t("chart.seq.arrow"), this.initial.arrow, arrowOptions);

    const textRow = h("div", { cls: "mtk-field" });
    textRow.appendChild(h("label", { cls: "mtk-field-label", text: t("chart.seq.text") }));
    const textInput = h("input", {
      cls: "mtk-input",
      attr: { type: "text", placeholder: t("chart.seq.newMessage") },
    });
    textInput.value = this.initial.text;
    textRow.appendChild(textInput);

    contentEl.append(from, to, arrow, textRow);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", { cls: "mtk-btn", text: t("settings.toolbar.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = h("button", { cls: "mtk-btn mtk-btn-primary", text: t("chart.seq.confirm"), attr: { type: "button" } });
    submit.addEventListener("click", () => this.submit(from, to, arrow, textInput));
    actions.append(cancel, submit);
    contentEl.appendChild(actions);

    (from.lastElementChild as HTMLSelectElement | null)?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private buildSelect(label: string, value: string, options: Array<{ value: string; label: string }>): HTMLDivElement {
    const row = h("div", { cls: "mtk-field" });
    row.appendChild(h("label", { cls: "mtk-field-label", text: label }));
    const select = h("select", { cls: "mtk-input mtk-prop-select" });
    for (const option of options) {
      const node = h("option", { text: option.label });
      node.value = option.value;
      select.appendChild(node);
    }
    select.value = value;
    row.appendChild(select);
    return row;
  }

  private submit(from: HTMLDivElement, to: HTMLDivElement, arrow: HTMLDivElement, text: HTMLInputElement): void {
    this.onSubmit({
      from: (from.lastElementChild as HTMLSelectElement).value,
      to: (to.lastElementChild as HTMLSelectElement).value,
      arrow: (arrow.lastElementChild as HTMLSelectElement).value,
      text: text.value.trim(),
    });
    this.close();
  }
}

/**
 * The attribute/method editor for a class.
 *
 * Class members are a list — one entry per line — so this is a textarea rather
 * than the single-line fields `TextToolModal` offers. Each line is trimmed and
 * blank lines dropped before it is written back, matching what the side panel
 * used to do.
 */
class ClassMemberDialog extends Modal {
  private readonly title: string;
  private readonly initial: string;
  private readonly placeholder: string;
  private readonly onSubmit: (value: string) => void;

  constructor(
    app: App,
    title: string,
    initial: string,
    placeholder: string,
    onSubmit: (value: string) => void
  ) {
    super(app);
    this.title = title;
    this.initial = initial;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: this.title }));

    const area = h("textarea", { cls: "mtk-input mtk-prop-area" });
    area.rows = Math.min(12, Math.max(4, this.initial.split("\n").length + 1));
    area.value = this.initial;
    if (this.placeholder) area.placeholder = this.placeholder;
    area.spellcheck = false;
    contentEl.appendChild(area);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", { cls: "mtk-btn", text: t("settings.toolbar.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = h("button", { cls: "mtk-btn mtk-btn-primary", text: t("chart.class.confirm"), attr: { type: "button" } });
    submit.addEventListener("click", () => {
      this.onSubmit(area.value);
      this.close();
    });
    actions.append(cancel, submit);
    contentEl.appendChild(actions);

    area.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The relation editor for a class diagram.
 *
 * A relation is a type (one of the seven mermaid operators, picked from a
 * select) plus an optional role label. The endpoints are shown read-only: the
 * only way to re-point a relation is to delete it and draw a new one, which
 * keeps the editor from needing a second class picker.
 */
class RelationDialog extends Modal {
  private readonly relationOptions: Array<{ value: string; label: string }>;
  private readonly initial: { op: string; role: string; from: string; to: string };
  private readonly onSubmit: (values: { op: string; role: string }) => void;

  constructor(
    app: App,
    relationOptions: Array<{ value: string; label: string }>,
    initial: { op: string; role: string; from: string; to: string },
    onSubmit: (values: { op: string; role: string }) => void
  ) {
    super(app);
    this.relationOptions = relationOptions;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: t("chart.class.relTitle") }));
    contentEl.appendChild(
      h("p", { cls: "mtk-settings-note", text: `${this.initial.from} → ${this.initial.to}` })
    );

    const opRow = h("div", { cls: "mtk-field" });
    opRow.appendChild(h("label", { cls: "mtk-field-label", text: t("chart.class.relation") }));
    const opSelect = h("select", { cls: "mtk-input mtk-prop-select" });
    for (const option of this.relationOptions) {
      const node = h("option", { text: option.label });
      node.value = option.value;
      opSelect.appendChild(node);
    }
    opSelect.value = this.initial.op;
    opRow.appendChild(opSelect);
    contentEl.appendChild(opRow);

    const roleRow = h("div", { cls: "mtk-field" });
    roleRow.appendChild(h("label", { cls: "mtk-field-label", text: t("chart.class.role") }));
    const roleInput = h("input", {
      cls: "mtk-input",
      attr: { type: "text", placeholder: t("chart.class.role") },
    });
    roleInput.value = this.initial.role;
    roleRow.appendChild(roleInput);
    contentEl.appendChild(roleRow);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", { cls: "mtk-btn", text: t("settings.toolbar.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = h("button", { cls: "mtk-btn mtk-btn-primary", text: t("chart.class.confirm"), attr: { type: "button" } });
    submit.addEventListener("click", () => {
      this.onSubmit({ op: opSelect.value, role: roleInput.value.trim() });
      this.close();
    });
    actions.append(cancel, submit);
    contentEl.appendChild(actions);

    (opRow.lastElementChild as HTMLSelectElement | null)?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The relation editor for an ER diagram.
 *
 * Unlike a class relation (one operator), an ER relation has a cardinality at
 * each end plus a identifying/dashed flag. The endpoints are read-only — the
 * only way to re-point is to delete and redraw — so the dialog offers two
 * cardinality selects, the kind toggle and the optional label.
 */
class ErRelationDialog extends Modal {
  private readonly cardOptions: Array<{ value: string; label: string }>;
  private readonly initial: {
    left: string;
    right: string;
    identifying: boolean;
    label: string;
    from: string;
    to: string;
  };
  private readonly onSubmit: (values: {
    left: string;
    right: string;
    identifying: boolean;
    label: string;
  }) => void;

  constructor(
    app: App,
    cardOptions: Array<{ value: string; label: string }>,
    initial: { left: string; right: string; identifying: boolean; label: string; from: string; to: string },
    onSubmit: (values: { left: string; right: string; identifying: boolean; label: string }) => void
  ) {
    super(app);
    this.cardOptions = cardOptions;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: t("chart.er.editRelation") }));
    contentEl.appendChild(
      h("p", { cls: "mtk-settings-note", text: `${this.initial.from} → ${this.initial.to}` })
    );

    const leftRow = this.buildCardRow(this.initial.from, this.initial.left);
    const rightRow = this.buildCardRow(this.initial.to, this.initial.right);

    const kindRow = h("div", { cls: "mtk-field" });
    kindRow.appendChild(h("label", { cls: "mtk-field-label", text: t("chart.er.kind") }));
    const kindSelect = h("select", { cls: "mtk-input mtk-prop-select" });
    const solid = h("option", { text: t("chart.er.identifying") });
    solid.value = "solid";
    const dashed = h("option", { text: t("chart.er.nonIdentifying") });
    dashed.value = "dashed";
    kindSelect.append(solid, dashed);
    kindSelect.value = this.initial.identifying ? "solid" : "dashed";
    kindRow.appendChild(kindSelect);

    const labelRow = h("div", { cls: "mtk-field" });
    labelRow.appendChild(h("label", { cls: "mtk-field-label", text: t("chart.er.label") }));
    const labelInput = h("input", {
      cls: "mtk-input",
      attr: { type: "text", placeholder: t("chart.er.label") },
    });
    labelInput.value = this.initial.label;
    labelRow.appendChild(labelInput);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", { cls: "mtk-btn", text: t("settings.toolbar.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = h("button", { cls: "mtk-btn mtk-btn-primary", text: t("chart.class.confirm"), attr: { type: "button" } });
    submit.addEventListener("click", () => {
      this.onSubmit({
        left: (leftRow.lastElementChild as HTMLSelectElement).value,
        right: (rightRow.lastElementChild as HTMLSelectElement).value,
        identifying: (kindRow.lastElementChild as HTMLSelectElement).value === "solid",
        label: labelInput.value.trim(),
      });
      this.close();
    });
    actions.append(cancel, submit);
    contentEl.append(leftRow, rightRow, kindRow, labelRow, actions);

    (leftRow.lastElementChild as HTMLSelectElement | null)?.focus();
  }

  private buildCardRow(endpoint: string, value: string): HTMLDivElement {
    const row = h("div", { cls: "mtk-field" });
    row.appendChild(h("label", { cls: "mtk-field-label", text: `${endpoint} ${t("chart.er.side")}` }));
    const select = h("select", { cls: "mtk-input mtk-prop-select" });
    for (const option of this.cardOptions) {
      const node = h("option", { text: option.label });
      node.value = option.value;
      select.appendChild(node);
    }
    select.value = value;
    row.appendChild(select);
    return row;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
