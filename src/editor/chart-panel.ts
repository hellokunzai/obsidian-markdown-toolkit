import { Notice, Platform, setIcon } from "obsidian";
import { t } from "../i18n";
import { kindById } from "../core/kinds";
import type { ChartCanvasId, Point } from "../core/model";
import { chartSpec } from "../charts/registry";
import type { ChartField, ChartHandle, RegisteredSpec } from "../charts/types";
import { chartSvgDocument, paintChart } from "../charts/paint";
import { createSurface, readPalette, type DiagramSurface } from "../render/svg";
import { fitBounds } from "../render/fit";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";
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
  private expandButton!: HTMLButtonElement;

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
    this.root.append(header, toolbar, this.bodyWrap, this.buildHints());

    this.bindCanvas();
    this.bindKeyboard();
    this.syncExpandLabel();

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
    this.syncExpandLabel();
    // The container just changed size; recompute the fit on the next frame.
    window.setTimeout(() => this.fit(), 0);
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
    header.appendChild(h("span", { cls: "mtk-spacer" }));

    this.expandButton = h("button", { cls: "mtk-btn mtk-expand", text: t("editor.expand") });
    this.expandButton.type = "button";
    const save = h("button", { cls: "mtk-btn mtk-save", text: t("editor.save") });
    save.type = "button";
    const close = h("button", { cls: "mtk-btn mtk-close", text: t("editor.close") });
    close.type = "button";

    this.expandButton.addEventListener("click", () => {
      if (this.root.closest(".mtk-in-tab")) this.options.host.collapse();
      else this.options.host.expand();
    });
    save.addEventListener("click", () => void this.save());
    close.addEventListener("click", () => {
      void (async () => {
        if (this.dirty) await this.save();
        this.options.host.close();
      })();
    });

    header.append(this.expandButton, save, close);
    return header;
  }

  private buildToolbar(): HTMLElement {
    const toolbar = h("div", { cls: "mtk-toolbar" });

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

    const svgOut = this.buildButton("mtk-chart-export-svg", t("editor.toolbar.exportSvg"), "file-code");
    svgOut.addEventListener("click", () => void this.exportChart("svg"));
    const pngOut = this.buildButton("mtk-chart-export-png", t("editor.toolbar.exportPng"), "image");
    pngOut.addEventListener("click", () => void this.exportChart("png"));
    toolbar.append(svgOut, pngOut);

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

    this.propsEl = h("aside", { cls: "mtk-props" });

    this.bodyWrap.append(this.canvasWrap, this.propsEl);
  }

  private buildHints(): HTMLElement {
    const hints = h("div", { cls: "mtk-hints" });
    const keys = Platform.isMobile
      ? ["chart.hint.touch", ...this.spec.hints()]
      : ["chart.hint.pan", "chart.hint.zoom", ...this.spec.hints(), "chart.hint.delete"];
    for (const key of keys) hints.appendChild(h("span", { cls: "mtk-hint", text: t(key) }));
    return hints;
  }

  private syncExpandLabel(): void {
    const inTab = Boolean(this.root.closest(".mtk-in-tab"));
    const text = t(inTab ? "editor.collapse" : "editor.expand");
    this.expandButton.textContent = text;
    applyTooltip(this.expandButton, text);
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
      maxScale: Platform.isMobile ? 1 : 1.15,
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
    this.spec.remove(this.state, this.selected);
    this.selected = null;
    this.pushUndoIfChanged(before);
    this.commit(true);
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
        if (this.spec.onPick?.(this.state, hitId, point)) {
          this.pushUndoIfChanged(before);
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

  /* --------------------------------------------------------------- output */

  private async save(): Promise<void> {
    const source = this.getSource();
    this.dirty = false;
    await this.options.host.save(source);
  }

  private async exportChart(kind: "svg" | "png"): Promise<void> {
    const document_ = chartSvgDocument(this.spec, this.state, readPalette(this.svg), {
      background: kind === "png",
    });
    if (!document_) {
      new Notice(t("notice.emptyDiagram"));
      return;
    }
    await this.options.host.exportFile(kind, document_.svg, document_.width, document_.height);
  }
}
