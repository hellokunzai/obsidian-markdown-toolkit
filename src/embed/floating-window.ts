import { h } from "../utils/dom";
import { setCssVars } from "../utils/css-vars";

/**
 * Making the preview behave like a window rather than a poster: press it to
 * pick it up, drag the corner grip or spin the wheel to size it.
 *
 * Nothing about the result is written down anywhere. The panel opens centred at
 * whatever size the stylesheet says, every time, and the geometry the user
 * settles on lives as `--mtk-lightbox-*` custom properties on the panel for as
 * long as it is open. Three consequences, each of them a decision:
 *
 *  - The *default* is the absence of variables rather than a size written in
 *    TypeScript: `var(--mtk-lightbox-w, min(92vw, 1100px))` still opens at a
 *    sensible size on a screen this code has never seen.
 *  - The panel is centred by the overlay's flex box, so a drag is an *offset*
 *    from wherever that centring puts it. Moving a small window into a corner
 *    and then growing it keeps the corner under the pointer instead of walking
 *    away from it: half of every size change moves the flex centre, and the
 *    offset takes that half back.
 *  - Everything is measured from the panel's own rect once, when the gesture
 *    starts. A transform does not move layout, so those numbers stay true for
 *    the whole gesture even though the panel is being *drawn* somewhere else —
 *    reading the live rect back every frame would feed the previous frame into
 *    the next one.
 */

/** Below this the drawing has nowhere left to go and the close button covers it. */
const MIN_W = 320;
const MIN_H = 240;

/** How much of the room inside the overlay the window may be grown to. */
const MAX_W_FRACTION = 0.96;
const MAX_H_FRACTION = 0.94;

/** What one wheel notch — 100px of `deltaY` — does to the size. */
const WHEEL_STEP = 0.06;

/** Where the panel sits and how big it is. */
interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Gesture {
  /** Picking the whole window up, or pulling its corner. */
  mode: "move" | "size";
  pointerId: number;
  clientX: number;
  clientY: number;
  from: Placement;
}

export interface FloatingWindow {
  /** Detaches every listener and removes the grip. */
  destroy(): void;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * @param panel the element to move and resize
 * @param area the box the panel is centred in — the overlay, whose own rect is
 *   what says where "centred" is
 */
export function makeFloatingWindow(panel: HTMLElement, area: HTMLElement): FloatingWindow {
  const grip = h("div", { cls: "mtk-lightbox-grip" });
  grip.setAttribute("aria-hidden", "true");
  panel.appendChild(grip);

  /** `null` until the first gesture: the stylesheet's size, in the middle. */
  let at: Placement | null = null;
  let drag: Gesture | null = null;

  /**
   * The overlay's content box, in viewport coordinates.
   *
   * Everything is bounded by this rather than by `window.innerWidth`. The
   * overlay carries a `4vmin` padding, which is the window's breathing room at
   * the edges of the screen, so the space a child really has is smaller than the
   * viewport. A size clamped to the viewport is not merely too big — the flex
   * box silently shrinks it on the way out, so the panel ends up drawn smaller
   * than the number this module just recorded, and the next gesture starts from
   * a corner that is no longer where it thinks it is.
   */
  const frame = (): { left: number; top: number; width: number; height: number } => {
    const box = area.getBoundingClientRect();
    const style = window.getComputedStyle(area);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padX = padLeft + (parseFloat(style.paddingRight) || 0);
    const padY = padTop + (parseFloat(style.paddingBottom) || 0);
    return {
      left: box.left + padLeft,
      top: box.top + padTop,
      width: Math.max(0, box.width - padX),
      height: Math.max(0, box.height - padY),
    };
  };

  /** Where the flex centring would put a panel of this size, before any offset. */
  const centred = (w: number, h: number): { left: number; top: number } => {
    const box = frame();
    return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2 };
  };

  /** The largest the window may get, as a fraction of the room it has. */
  const maxW = (): number => Math.max(MIN_W, frame().width * MAX_W_FRACTION);
  const maxH = (): number => Math.max(MIN_H, frame().height * MAX_H_FRACTION);

  /**
   * Writes the geometry out and keeps the window on screen.
   *
   * The clamp is what makes the gesture feel solid rather than elastic: without
   * it a window thrown at a corner simply leaves, and there is no way back
   * short of reloading the note.
   */
  const place = (next: Placement): void => {
    const box = frame();
    const rest = centred(next.w, next.h);
    const x = clamp(next.x, box.left - rest.left, box.left + box.width - next.w - rest.left);
    const y = clamp(next.y, box.top - rest.top, box.top + box.height - next.h - rest.top);
    at = { x, y, w: next.w, h: next.h };
    setCssVars(panel, {
      "--mtk-lightbox-x": `${x}px`,
      "--mtk-lightbox-y": `${y}px`,
      "--mtk-lightbox-w": `${next.w}px`,
      "--mtk-lightbox-h": `${next.h}px`,
    });
  };

  /** The panel as it is right now — measured the first time, remembered after. */
  const current = (): Placement => {
    if (at) return at;
    const rect = panel.getBoundingClientRect();
    return { x: 0, y: 0, w: rect.width, h: rect.height };
  };

  const start = (event: PointerEvent, mode: Gesture["mode"]): void => {
    if (event.button !== 0) return;
    // Keeps the press from starting a selection of the labels it passes over,
    // which is a thing the browser is otherwise happy to do on its own.
    event.preventDefault();
    drag = {
      mode,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      from: current(),
    };
    panel.classList.add(mode === "move" ? "is-moving" : "is-sizing");
    try {
      // Without capture a drag dies the moment the cursor leaves the panel —
      // which is exactly what dragging a window towards the screen edge does.
      panel.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is best effort; the moves that stay inside still arrive. */
    }
  };

  const move = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    const from = drag.from;

    if (drag.mode === "move") {
      place({ ...from, x: from.x + dx, y: from.y + dy });
      return;
    }

    const w = clamp(from.w + dx, MIN_W, maxW());
    const h = clamp(from.h + dy, MIN_H, maxH());
    place({
      w,
      h,
      // Half of the change is absorbed by the re-centring, so the offset hands
      // it back — that is what pins the corner under the pointer.
      x: from.x + (w - from.w) / 2,
      y: from.y + (h - from.h) / 2,
    });
  };

  const end = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    panel.classList.remove("is-moving", "is-sizing");
  };

  const wheel = (event: WheelEvent): void => {
    const now = current();
    // Three units, three scales: a mouse notch is 100px, a line is ~16px, and a
    // page is the whole window.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const notches = (event.deltaY * unit) / 100;
    // A fixed *fraction* per notch, not a fixed number of pixels: the same
    // gesture has to feel the same on a 1100px window and on a 320px one.
    const k = Math.pow(1 - WHEEL_STEP, notches);
    // Not passive: a wheel over the preview must not scroll the note behind it.
    event.preventDefault();
    // The offset is left alone, so the window grows around its own centre —
    // which is where the eye is when the wheel is what is doing the resizing.
    place({
      x: now.x,
      y: now.y,
      w: clamp(now.w * k, MIN_W, maxW()),
      h: clamp(now.h * k, MIN_H, maxH()),
    });
  };

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    // Buttons — the close entry, and anything that lives here later — keep
    // their own gesture: pressing one is not picking the window up.
    if (target?.closest("button")) return;
    start(event, target?.closest(".mtk-lightbox-grip") ? "size" : "move");
  };

  panel.addEventListener("pointerdown", onPointerDown);
  panel.addEventListener("pointermove", move);
  panel.addEventListener("pointerup", end);
  panel.addEventListener("pointercancel", end);
  panel.addEventListener("wheel", wheel, { passive: false });

  return {
    destroy(): void {
      panel.removeEventListener("pointerdown", onPointerDown);
      panel.removeEventListener("pointermove", move);
      panel.removeEventListener("pointerup", end);
      panel.removeEventListener("pointercancel", end);
      panel.removeEventListener("wheel", wheel);
      panel.classList.remove("is-moving", "is-sizing");
      grip.remove();
    },
  };
}
