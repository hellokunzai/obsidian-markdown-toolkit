import { modelBounds } from "../core/measure";
import type { DiagramModel } from "../core/model";

/**
 * Fitting a drawing into a box.
 *
 * One implementation for every caller — the node-and-edge editor, the chart
 * canvases, and the preview embedded in the note. Three copies of this maths is
 * three ways for the same diagram to be framed differently in three places.
 */

export interface Viewport {
  k: number;
  tx: number;
  ty: number;
}

export interface FitOptions {
  padding: number;
  /** Never magnify past this; a two-node diagram should not fill the screen. */
  maxScale: number;
  /**
   * Fit the height and anchor to the left, letting the user pan sideways. This
   * is what a phone wants: fitting the width of a wide tree makes it unreadable.
   */
  anchorLeft?: boolean;
}

/** A box in model coordinates. Structurally what every caller already has. */
export interface FitBoundsBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The maths itself, over a box rather than a model.
 *
 * Split out because the chart canvases have no `DiagramModel` — a gantt chart
 * is a time axis, a pie chart is sectors — but they do have a bounding box, and
 * "frame this box in this viewport" is the same question for all of them.
 */
export function fitBounds(
  bounds: FitBoundsBox,
  width: number,
  height: number,
  options: FitOptions
): Viewport {
  const spanX = Math.max(1, bounds.x2 - bounds.x1);
  const spanY = Math.max(1, bounds.y2 - bounds.y1);
  const midX = (bounds.x1 + bounds.x2) / 2;
  const midY = (bounds.y1 + bounds.y2) / 2;
  const pad = options.padding;

  if (options.anchorLeft) {
    const k = Math.min((height - pad * 2) / spanY, options.maxScale);
    return { k, tx: pad - bounds.x1 * k, ty: height / 2 - midY * k };
  }
  const k = Math.min(
    (width - pad * 2) / spanX,
    (height - pad * 2) / spanY,
    options.maxScale
  );
  return { k, tx: width / 2 - midX * k, ty: height / 2 - midY * k };
}

export interface AutoFitOptions {
  padding: number;
  /** Never magnify past this; a two-node diagram should not fill the screen. */
  maxScale: number;
  /** A drawing thinner than this still gets a frame worth aiming at. */
  minHeight: number;
}

/** A viewport, plus the height the box has to be for it to be the right one. */
export interface FittedBox {
  view: Viewport;
  boxHeight: number;
}

/**
 * Frame a drawing by its width, and report the height the box needs.
 *
 * The counterpart to `fitBounds`, and the one the block in a note uses.
 * `fitBounds` treats width and height as independent constraints, which is
 * right for a canvas the user has sized — the drawing has to live inside
 * whatever it was handed. Inline in a note the relationship is the other way
 * round: the note decides the width, so the drawing gets to decide the height.
 * Constraining both is what shrank a fourteen-node mind map into 7.6px labels,
 * because the height it was measured against came from the stylesheet rather
 * than from the diagram.
 *
 * The drawing is centred in the box it asks for, because the box is now exactly
 * as tall as the drawing plus the padding — there is no slack left to spend.
 */
export function fitBoundsToWidth(
  bounds: FitBoundsBox,
  width: number,
  options: AutoFitOptions
): FittedBox {
  const spanX = Math.max(1, bounds.x2 - bounds.x1);
  const spanY = Math.max(1, bounds.y2 - bounds.y1);
  const midX = (bounds.x1 + bounds.x2) / 2;
  const midY = (bounds.y1 + bounds.y2) / 2;
  const pad = options.padding;

  // The floor matters only for a box narrower than its own padding, where the
  // width term goes non-positive; without it the drawing would be scaled to
  // nothing rather than to something small.
  const k = Math.max(0.05, Math.min(options.maxScale, (width - pad * 2) / spanX));
  const boxHeight = Math.max(options.minHeight, spanY * k + pad * 2);
  return {
    view: { k, tx: width / 2 - midX * k, ty: boxHeight / 2 - midY * k },
    boxHeight,
  };
}

export function applyViewport(layer: SVGGElement, view: Viewport): void {
  layer.setAttribute("transform", `translate(${view.tx},${view.ty}) scale(${view.k})`);
}

/** `fitBounds` over a graph model's own outline. `null` when there is nothing to frame. */
export function computeFit(
  model: DiagramModel,
  width: number,
  height: number,
  options: FitOptions
): Viewport | null {
  if (!width || !height) return null;
  const bounds = modelBounds(model);
  if (!bounds) return null;
  return fitBounds(bounds, width, height, options);
}
