import { applyViewport, type Viewport } from "../render/fit";

/**
 * The drawing moves inside the preview; the preview itself stays put.
 *
 * The preview opens as a fixed, centred frame — a picture frame rather than a
 * window — and everything the pointer does happens *inside* it: drag to slide
 * the drawing under the glass, spin the wheel to zoom towards the cursor, and
 * double-click to drop it back where it started. The frame never moves and
 * never changes size, which is the whole point: there is exactly one thing a
 * gesture can be about, so there is no mode to keep track of and no need to
 * guess whether a press is meant for the picture or for the frame around it.
 * The same drag works whether it starts on a node or on the empty space beside
 * one, which is also why the whole frame wears `cursor: grab`.
 *
 * Two things are deliberately *not* remembered. The frame's opening geometry
 * belongs to the stylesheet, so it opens centred on any screen this code has
 * never seen; and the drawing is re-framed whenever the frame changes size —
 * unless the user has taken over. That clause is the entire state machine:
 * `taken` false means "frame it for me", true means "leave it alone", and
 * double-clicking is the way back from one to the other.
 *
 * Zoom is bounded as a *multiple of the fitted view* rather than in absolute
 * units, because the fitted view is the only scale that means anything across
 * diagrams: a three-node flow and a thirty-node mind map arrive at zoom factors
 * ten times apart, so an absolute floor would be unreachable on one of them and
 * useless on the other.
 */

/** How far the wheel may travel from the fitted view, as a multiple of it. */
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 8;

/** What one wheel notch — 100px of `deltaY` — multiplies the zoom by. */
const WHEEL_STEP = 1.06;

interface Pan {
  pointerId: number;
  clientX: number;
  clientY: number;
  /**
   * The viewport as it was when the press landed. The drag is an offset from
   * it rather than an accumulation of per-move deltas, so a move the browser
   * coalesces or drops costs one frame of travel instead of permanent drift.
   */
  tx: number;
  ty: number;
}

export interface PreviewViewport {
  /** Frames the drawing again, as if the preview had just opened. */
  reset(): void;
  /** Detaches every listener and stops watching the frame. */
  destroy(): void;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * @param panel the frame — what the pointer acts on, and the element whose size
 *   says when the drawing needs framing again
 * @param layer the `<g>` the viewport is written to
 * @param fit produces the framing for the panel's size right now, or `null`
 *   when there is nothing to frame yet (a chart with no rows, a frame that has
 *   not been laid out)
 */
export function makePreviewViewport(
  panel: HTMLElement,
  layer: SVGGElement,
  fit: () => Viewport | null
): PreviewViewport {
  let view: Viewport | null = null;
  /** The zoom the framing settled on — the unit every bound is measured in. */
  let base = 1;
  /** Whether the user has placed the drawing themselves. */
  let taken = false;
  let pan: Pan | null = null;

  const paint = (): void => {
    if (view) applyViewport(layer, view);
  };

  const reset = (): void => {
    if (!panel.clientWidth || !panel.clientHeight) return;
    const next = fit();
    if (!next) return;
    view = next;
    base = next.k;
    taken = false;
    paint();
  };

  /**
   * Zooms by `factor` around a point on screen, which stays where it is.
   *
   * This is why the preview is not zoomed about its own centre: a point
   * anchored zoom keeps whatever the user is looking at under their cursor,
   * while a centre anchored one pushes it off the edge and turns "read that
   * node" into a two-step gesture.
   */
  const zoomAt = (factor: number, clientX: number, clientY: number): void => {
    if (!view) return;
    const k = clamp(view.k * factor, base * MIN_FACTOR, base * MAX_FACTOR);
    const ratio = k / view.k;
    if (ratio === 1) return;
    const rect = panel.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    view = {
      k,
      tx: cx - (cx - view.tx) * ratio,
      ty: cy - (cy - view.ty) * ratio,
    };
    taken = true;
    paint();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !view) return;
    // The close entry keeps its own gesture: pressing it is not picking the
    // drawing up. Note what is *not* done here — `preventDefault` would be the
    // obvious way to stop a drag from selecting the labels it passes over, but
    // it takes the compatibility mouse events down with it, and `dblclick` is
    // one of them. The selection is stopped in CSS instead, with
    // `user-select: none` on the frame.
    if ((event.target as Element | null)?.closest("button")) return;
    pan = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      tx: view.tx,
      ty: view.ty,
    };
    panel.classList.add("is-panning");
    try {
      // Without capture the drag dies as soon as the cursor leaves the frame,
      // which — dragging along a wide diagram — is most of a long drag.
      panel.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is best effort; the moves that stay inside still arrive. */
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pan || event.pointerId !== pan.pointerId || !view) return;
    view = {
      k: view.k,
      tx: pan.tx + (event.clientX - pan.clientX),
      ty: pan.ty + (event.clientY - pan.clientY),
    };
    taken = true;
    paint();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    pan = null;
    panel.classList.remove("is-panning");
  };

  const onWheel = (event: WheelEvent): void => {
    // Three units, three scales: a mouse notch is 100px, a line is ~16px, and a
    // page is the height of the frame.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientHeight : 1;
    const notches = -(event.deltaY * unit) / 100;
    // Not passive: a wheel over the preview must not scroll the note behind it.
    event.preventDefault();
    zoomAt(Math.pow(WHEEL_STEP, notches), event.clientX, event.clientY);
  };

  /**
   * A frame that changes size re-frames the drawing — but only while the
   * drawing is still this module's to place. Once the user has moved it
   * somewhere, resizing the window must not quietly undo that.
   */
  const observer = new ResizeObserver(() => {
    if (!taken) reset();
  });
  observer.observe(panel);

  panel.addEventListener("pointerdown", onPointerDown);
  panel.addEventListener("pointermove", onPointerMove);
  panel.addEventListener("pointerup", onPointerUp);
  panel.addEventListener("pointercancel", onPointerUp);
  panel.addEventListener("wheel", onWheel, { passive: false });
  panel.addEventListener("dblclick", reset);

  // The frame has no size until it has been laid out, so the opening framing
  // happens on the next turn of the loop rather than here.
  const opening = window.setTimeout(reset, 0);

  return {
    reset,
    destroy(): void {
      window.clearTimeout(opening);
      observer.disconnect();
      panel.removeEventListener("pointerdown", onPointerDown);
      panel.removeEventListener("pointermove", onPointerMove);
      panel.removeEventListener("pointerup", onPointerUp);
      panel.removeEventListener("pointercancel", onPointerUp);
      panel.removeEventListener("wheel", onWheel);
      panel.removeEventListener("dblclick", reset);
      panel.classList.remove("is-panning");
    },
  };
}
