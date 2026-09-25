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
  type FitBoundsBox,
} from "../render/fit";
import type { DiagramMode } from "../core/model";
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
 * "enlarge this", the editor wants "open the canvas" and "give me the source
 * back". Each mode's primary action takes the centre spot — enlarging in the
 * note, opening the canvas in the editor — so the two read as the same object,
 * while secondary actions go to the corners.
 */
export interface DiagramBoxActions {
  /** Centre button that opens the visual editor. */
  onEdit?: () => void;
  /** Corner button that hands the block back to the plain markdown editor. */
  onSource?: () => void;
  /** Centre button that only enlarges the drawing. */
  onView?: () => void;
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

        const bounds = spec.extent(state);
        if (bounds) {
          const surface = createSurface(canvas);
          paintChart(surface, spec, state, {
            palette: readPalette(surface.svg),
            interactive: false,
          });
          fit = () => sizeTo(surface.layer, bounds);
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
          if (model.mode === "mindmap") layoutMindmap(model, host.settings.mindmapLayout);
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
  const sizeTo = (layer: SVGGElement, bounds: FitBoundsBox): void => {
    if (!canvas.clientWidth) return;
    const fitted = fitBoundsToWidth(bounds, canvas.clientWidth, INLINE_FIT);
    setCssVars(canvas, { "--mtk-canvas-h": `${fitted.boxHeight}px` });
    applyViewport(layer, fitted.view);
  };

  paint();

  // One primary action per mode, always in the centre: the editor's edit entry
  // sits exactly where the reading view's enlarge entry does.
  const edit = actions.onEdit ? labelledButton("mtk-embed-edit", t("embed.edit"), actions.onEdit) : null;
  if (edit) box.appendChild(edit);

  if (actions.onSource) {
    // An icon rather than a label: this is the "hand it back to markdown"
    // affordance the block had before it was replaced, and it reads as such at
    // 26px, where a word would not fit.
    const own = h("button", { cls: "mtk-embed-code" });
    own.type = "button";
    setIcon(own, "code");
    applyTooltip(own, t("embed.viewSource"));
    own.addEventListener("click", () => actions.onSource?.());
    box.appendChild(own);
  }

  if (actions.onView) {
    const pill = h("button", { cls: "mtk-embed-pill" });
    pill.type = "button";
    pill.appendChild(h("span", { text: t("embed.view") }));
    applyTooltip(pill, t("embed.view"));
    pill.addEventListener("click", () => actions.onView?.());
    box.appendChild(pill);
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

/** A labelled pill button; where it sits is decided by its class. */
function labelledButton(cls: string, label: string, onClick: () => void): HTMLElement {
  const button = h("button", { cls });
  button.type = "button";
  button.appendChild(h("span", { text: label }));
  applyTooltip(button, label);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * A full-screen, read-only copy of the diagram, painted fresh at the overlay's
 * size so it fits the viewport instead of reusing the block's small canvas.
 *
 * Re-painting rather than cloning the inline SVG also keeps the preview
 * independent of the block: closing the note does not tear the lightbox down,
 * and the theme palette is resolved against the overlay, not the note.
 */
export function openLightbox(host: DiagramBoxHost, source: string, mode: DiagramMode): void {
  if (document.querySelector(".mtk-lightbox")) return;

  const overlay = h("div", { cls: "mtk-lightbox" });
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const canvas = h("div", { cls: "mtk-lightbox-canvas" });
  overlay.appendChild(canvas);

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  const closeButton = h("button", { cls: "mtk-lightbox-close" });
  closeButton.type = "button";
  setIcon(closeButton, "x");
  applyTooltip(closeButton, t("embed.lightboxClose"));
  closeButton.addEventListener("click", () => close());
  canvas.appendChild(closeButton);

  document.body.appendChild(overlay);

  const surface = createSurface(canvas);
  const frame = (bounds: FitBoundsBox): void => {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    applyViewport(
      surface.layer,
      fitBounds(bounds, canvas.clientWidth, canvas.clientHeight, {
        ...LIGHTBOX_FIT,
        anchorLeft: false,
      })
    );
  };

  if (isChartMode(mode)) {
    const spec = chartSpec(mode);
    const state = spec.parse(source);
    spec.layout(state);
    paintChart(surface, spec, state, { palette: readPalette(surface.svg), interactive: false });
    const bounds = spec.extent(state);
    window.setTimeout(() => {
      if (bounds) frame(bounds);
    }, 0);
    return;
  }

  const parsed = parseDiagram(source, mode);
  if (!parsed.ok) {
    canvas.appendChild(h("div", { cls: "mtk-embed-message", text: t("embed.parseFailed") }));
    return;
  }
  const model = parsed.model;
  if (model.mode === "mindmap") layoutMindmap(model, host.settings.mindmapLayout);
  else layoutFlow(model);
  applyPinnedPositions(model);
  renderDiagram(surface, model, { interactive: false, selectedId: null });
  window.setTimeout(() => {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    const view = computeFit(model, canvas.clientWidth, canvas.clientHeight, {
      ...LIGHTBOX_FIT,
      anchorLeft: false,
    });
    if (view) applyViewport(surface.layer, view);
  }, 0);
}
