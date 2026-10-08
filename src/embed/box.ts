import { setIcon } from "obsidian";
import { t } from "../i18n";
import { layoutFlow } from "../core/layout-flow";
import { layoutMindmap } from "../core/layout-mindmap";
import { applyPinnedPositions, parseDiagram } from "../core/parse";
import { modelBounds } from "../core/measure";
import { chartSpec, isChartMode } from "../charts/registry";
import { paintChart } from "../charts/paint";
import { createSurface, readPalette, renderDiagram } from "../render/svg";
import {
  applyViewport,
  computeFit,
  fitBounds,
  fitBoundsToWidth,
  type AutoFitOptions,
  type FitBoundsBox,
  type Viewport,
} from "../render/fit";
import type { DiagramMode } from "../core/model";
import { makePreviewViewport, type PreviewViewport } from "./preview-viewport";
import { openExportMenu, type ExportKind } from "./export-block";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";
import { setCssVars } from "../utils/css-vars";
import type { MarkdownEditorPlusSettings } from "../settings";

/**
 * The inline drawing, as one piece of DOM.
 *
 * The same box is produced in two very different places — the reading view and
 * the Live Preview editor — and the two have to stay indistinguishable: a
 * diagram that looks or behaves differently depending on which mode the user
 * happens to be in is not a feature, it is the bug report that made this file
 * exist. So the drawing, the framing, the count badge and the entry buttons are
 * all built here, and the two callers differ in exactly one thing: which entry
 * buttons they ask for, and what those buttons do.
 *
 * The framing maths is shared with the editors (`fitBounds`), so a diagram is
 * framed the same way in the note as on a canvas.
 */

/** The slice of the plugin a box draws with. */
export interface DiagramBoxHost {
  readonly settings: MarkdownEditorPlusSettings;
}

/**
 * Which entry points a box carries.
 *
 * Named by the caller rather than inferred from the DOM: the reading view wants
 * "show me this bigger", the editor wants "open the canvas" and "give me the
 * source back". Every entry is a corner icon button, so whichever mode the note
 * is read in, the block wears the same family of 26px squares.
 */
export interface DiagramBoxActions {
  /** Corner icon button (left of the code entry) that opens the visual editor. */
  onEdit?: () => void;
  /** Corner button that hands the block back to the plain markdown editor. */
  onSource?: () => void;
  /** Corner icon button that shows the drawing full screen. */
  onView?: () => void;
  /** Corner icon button that writes the drawing to a file, as a menu of formats. */
  onExport?: (kind: ExportKind) => void;
}

export interface BuiltDiagramBox {
  el: HTMLElement;
  /** Paints again in place; the palette is read from CSS, so a theme switch needs this. */
  repaint(): void;
  /** Releases the resize observer and everything the buttons hold. */
  destroy(): void;
}

/**
 * How the block in the note frames a drawing.
 *
 * `minHeight` is the one value here that is not framing maths: a three-node
 * flow is about 90px of ink, and a frame thinner than that reads as a stray
 * rule rather than as a drawing.
 */
const INLINE_FIT = { padding: 26, maxScale: 1.15, minHeight: 88 };
const LIGHTBOX_FIT = { padding: 40, maxScale: 2.4 };

/** The same "here is the source" affordance the parse failure uses. */
export function sourceDetails(source: string): HTMLElement {
  const details = h("details", { cls: "mtk-embed-source" });
  details.appendChild(h("summary", { text: t("embed.viewSource") }));
  const pre = h("pre", { cls: "mtk-embed-pre" });
  pre.textContent = source;
  details.appendChild(pre);
  return details;
}

export function buildDiagramBox(
  host: DiagramBoxHost,
  source: string,
  mode: DiagramMode,
  actions: DiagramBoxActions
): BuiltDiagramBox {
  const box = h("div", { cls: "mtk-embed" });
  const canvas = h("div", { cls: "mtk-canvas-static" });
  box.appendChild(canvas);

  const badgeText = h("span");
  const badge = h("div", { cls: "mtk-embed-meta" });
  badge.appendChild(badgeText);
  box.appendChild(badge);

  let observer: ResizeObserver | null = null;

  /**
   * The count badge is written by the paint, not by the caller: which numbers
   * exist depends on how the body parsed, and a repaint after a theme switch
   * must not leave yesterday's count behind.
   */
  const paint = (): void => {
    observer?.disconnect();
    observer = null;
    canvas.replaceChildren();
    canvas.classList.remove("mtk-canvas-hug");
    let text: string | null = null;
    let fit: (() => void) | null = null;

    // An empty block is a normal starting point, not an error: it keeps its
    // entry points so the diagram can be built from the canvas.
    if (source.trim()) {
      if (isChartMode(mode)) {
        const spec = chartSpec(mode);
        const state = spec.parse(source);
        spec.layout(state);
        const counts = spec.summary(state);
        text =
          counts.edges > 0
            ? t("chart.summaryBoth", { nodes: counts.nodes, edges: counts.edges })
            : t("chart.summaryOne", { nodes: counts.nodes });

        // A preliminary bounds check (fallback width) decides whether to draw at
        // all; the real, width-aware paint is deferred until the canvas actually
        // has a width, because a width-aware spec (the gantt) spreads its axis to
        // fill the column and must be laid out against the real width.
        const bounds = spec.extent(state);
        if (bounds) {
          const surface = createSurface(canvas);
          const palette = readPalette(surface.svg);
          let lastWidth = 0;
          let lastBounds: FitBoundsBox | null = null;
          fit = () => {
            const width = canvas.clientWidth;
            if (!width) return;
            // Re-paint only when the width changed (a width-aware chart needs a
            // fresh layout at the new width; the rest are unaffected but cheap).
            if (width !== lastWidth) {
              spec.layout(state);
              paintChart(surface, spec, state, { palette, interactive: false, width });
              lastBounds = spec.extent(state);
              lastWidth = width;
            }
            if (lastBounds) {
              // The spec's fit override wins over the generic cap (see `ChartSpec.fit`).
              sizeTo(surface.layer, lastBounds, {
                ...INLINE_FIT,
                maxScale: spec.fit?.maxScale ?? INLINE_FIT.maxScale,
              });
            }
          };
        }
      } else {
        const parsed = parseDiagram(source, mode);
        if (!parsed.ok) {
          // Text we cannot read stays visible and copyable — and, in the
          // editor, fixable from right here rather than only in the source.
          // The canvas is released from its fixed height for this: a diagram
          // that is being repaired can be any length, and clipping the source
          // would hide the very lines that need fixing.
          canvas.classList.add("mtk-canvas-hug");
          canvas.appendChild(h("div", { cls: "mtk-embed-message", text: t("embed.parseFailed") }));
          canvas.appendChild(sourceDetails(source));
        } else {
          const model = parsed.model;
          if (model.mode === "mindmap") layoutMindmap(model);
          else layoutFlow(model);
          applyPinnedPositions(model);
          text = t("embed.summary", { nodes: model.nodes.length, edges: model.edges.length });

          if (model.nodes.length) {
            const surface = createSurface(canvas);
            renderDiagram(surface, model, { interactive: false, selectedId: null });
            const bounds = modelBounds(model);
            if (bounds) fit = () => sizeTo(surface.layer, bounds);
          }
        }
      }
    }

    badgeText.textContent = text ?? "";
    if (fit) {
      // Once on the next frame (the canvas has no size until then) and then on
      // every resize it gets afterwards.
      window.setTimeout(fit, 0);
      observer = new ResizeObserver(fit);
      observer.observe(canvas);
    }
  };

  /**
   * Frames the drawing and sizes the box to fit it.
   *
   * The height is an *output* of the framing maths here, not an input: the note
   * fixes the width, so the drawing gets to decide how tall the frame has to
   * be. Passing a height in as well is what shrank a fourteen-node mind map
   * into 7.6px labels — the drawing was being fitted to a box that only existed
   * because it had been written down in the stylesheet.
   *
   * Guarded once here rather than at each caller: the first paint runs before
   * layout, and every resize afterwards comes through the same path.
   */
  const sizeTo = (layer: SVGGElement, bounds: FitBoundsBox, options: AutoFitOptions = INLINE_FIT): void => {
    if (!canvas.clientWidth) return;
    const fitted = fitBoundsToWidth(bounds, canvas.clientWidth, options);
    setCssVars(canvas, { "--mtk-canvas-h": `${fitted.boxHeight}px` });
    applyViewport(layer, fitted.view);
  };

  paint();

  // The block's entries, as one family of 26px squares in the top-right corner:
  // "edit the drawing", "give me the file", "show it bigger", "hand it back to
  // markdown". Whichever of them a mode asks for, they are the same squares in
  // the same corner — see `DiagramBoxActions` for why that matters.
  //
  // Every action is an icon, never a label — a word does not fit in a 26px
  // square. Glyphs are Lucide's, borrowed rather than drawn: `square-pen` for
  // the editor's entry and `maximize-2` for the reading view's, the latter
  // being the name Obsidian's own alias table gives `enlarge-glyph`. A
  // hand-drawn twin of the edit entry was tried first and had to go: `addIcon`
  // registers the glyph under a name Obsidian then adds to the icon element as
  // a *class*, so naming it `mtk-embed-edit` made the button's own rules —
  // absolute placement at `right: 40px`, and `opacity: 0` until hover — apply
  // to the glyph as well, parking it outside its own button. See the
  // `.mtk-embed-action` rules in `styles.css` for the other half of the fix.
  const onEdit = actions.onEdit;
  if (onEdit) {
    const edit = h("button", { cls: "mtk-embed-action mtk-embed-edit" });
    edit.type = "button";
    setIcon(edit, "square-pen");
    applyTooltip(edit, t("embed.edit"));
    edit.addEventListener("click", () => onEdit());
    box.appendChild(edit);
  }

  const onExport = actions.onExport;
  if (onExport) {
    // Marks the block as "has an export entry" so the corner's slot math in
    // `styles.css` knows the editor's "edit" entry must step out one slot to
    // make room. Blocks without export (the Live Preview widget) skip this and
    // the edit button takes the second slot directly.
    box.classList.add("mtk-embed-has-export");
    // Placed before the two "leave the drawing alone" entries so the corner
    // reads left to right in the order the buttons were added. It is one button
    // and a menu rather than one button per format: see `openExportMenu`.
    const out = h("button", { cls: "mtk-embed-action mtk-embed-export" });
    out.type = "button";
    setIcon(out, "download");
    applyTooltip(out, t("embed.export"));
    out.addEventListener("click", () => openExportMenu(out, onExport));
    box.appendChild(out);
  }

  if (actions.onSource) {
    // The "hand it back to markdown" affordance the block had before it was
    // replaced, kept as an icon so it reads as one of the same family.
    const own = h("button", { cls: "mtk-embed-action mtk-embed-code" });
    own.type = "button";
    setIcon(own, "code");
    applyTooltip(own, t("embed.viewSource"));
    own.addEventListener("click", () => actions.onSource?.());
    box.appendChild(own);
  }

  if (actions.onView) {
    // The reading view's only entry, and the one action that is not "go back to
    // the text": it takes the corner for itself, since nothing else is there to
    // share it with.
    const view = h("button", { cls: "mtk-embed-action mtk-embed-view" });
    view.type = "button";
    setIcon(view, "maximize-2");
    applyTooltip(view, t("embed.view"));
    view.addEventListener("click", () => actions.onView?.());
    box.appendChild(view);
  }

  return {
    el: box,
    repaint: paint,
    destroy(): void {
      observer?.disconnect();
      observer = null;
    },
  };
}

/**
 * A full-screen copy of the diagram, painted fresh at the window's own size so
 * it fits what is on screen instead of reusing the block's small canvas.
 *
 * Re-painting rather than cloning the inline SVG also keeps the preview
 * independent of the block: closing the note does not tear the lightbox down,
 * and the theme palette is resolved against the overlay, not the note — which
 * is why `styles.css` carries the diagram's colours on `.mtk-lightbox` as well
 * as on the two places a diagram is normally shown.
 *
 * The preview is a fixed frame and the *drawing* is what takes gestures (see
 * `makePreviewViewport`), so this function's job around it is narrow: work out
 * how to frame the drawing for the frame's size, hand that to the gesture
 * layer, and take it back on the way out.
 */
export function openLightbox(
  host: DiagramBoxHost,
  source: string,
  mode: DiagramMode
): void {
  if (document.querySelector(".mtk-lightbox")) return;

  const overlay = h("div", { cls: "mtk-lightbox" });
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const canvas = h("div", { cls: "mtk-lightbox-canvas" });
  overlay.appendChild(canvas);

  let viewport: PreviewViewport | null = null;

  /* The one corner button. The preview carries no actions of its own beyond
     closing: the block in the note already carries the export entry, and the
     preview is already the largest the drawing gets — a "full screen" toggle
     inside a fixed overlay would only shrink the frame. */

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    viewport?.destroy();
    viewport = null;
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    close();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  const closeButton = h("button", { cls: "mtk-lightbox-action mtk-lightbox-close" });
  closeButton.type = "button";
  setIcon(closeButton, "x");
  applyTooltip(closeButton, t("embed.lightboxClose"));
  closeButton.addEventListener("click", () => close());
  canvas.appendChild(closeButton);

  document.body.appendChild(overlay);

  const surface = createSurface(canvas);

  /**
   * How to frame the drawing at the frame's current size.
   *
   * Charts hand over their own bounding box and node graphs go through
   * `computeFit`, so the two settle into one shape here rather than two copies
   * of "frame the drawing". Both are recomputed on every call, because the
   * frame's size is the input and the answer is worthless the moment it
   * changes.
   */
  let fit: (() => Viewport | null) | null = null;

  if (isChartMode(mode)) {
    const spec = chartSpec(mode);
    const state = spec.parse(source);
    const palette = readPalette(surface.svg);
    let lastWidth = 0;
    // Frames the drawing at the canvas's current size. A width-aware spec (the
    // gantt) re-lays-out to fill the width, so it is re-painted whenever the
    // width changes; the rest only repaint on the first frame.
    const draw = (): Viewport | null => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return null;
      if (width !== lastWidth) {
        spec.layout(state);
        paintChart(surface, spec, state, { palette, interactive: false, width });
        lastWidth = width;
      }
      const bounds = spec.extent(state);
      if (!bounds) return null;
      return fitBounds(bounds, width, height, {
        ...LIGHTBOX_FIT,
        maxScale: spec.fit?.maxScale ?? LIGHTBOX_FIT.maxScale,
        anchorLeft: false,
      });
    };
    // Paint once up front (no width) so the preview is never blank before the
    // first re-frame, then let the preview viewport take over at the real size.
    spec.layout(state);
    paintChart(surface, spec, state, { palette, interactive: false, width: 0 });
    const initial = draw();
    if (initial) fit = draw;
  } else {
    const parsed = parseDiagram(source, mode);
    if (!parsed.ok) {
      canvas.appendChild(h("div", { cls: "mtk-embed-message", text: t("embed.parseFailed") }));
    } else {
      const model = parsed.model;
      if (model.mode === "mindmap") layoutMindmap(model);
      else layoutFlow(model);
      applyPinnedPositions(model);
      renderDiagram(surface, model, { interactive: false, selectedId: null });
      fit = () =>
        computeFit(model, canvas.clientWidth, canvas.clientHeight, {
          ...LIGHTBOX_FIT,
          anchorLeft: false,
        });
    }
  }

  if (fit) viewport = makePreviewViewport(canvas, surface.layer, fit);
}
