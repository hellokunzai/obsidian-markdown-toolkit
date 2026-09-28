/**
 * The fullscreen toggle in a dialog's top-right corner.
 *
 * Every editing dialog gets one, sitting beside the native close button. The
 * mode it toggles is maximization rather than browser fullscreen: the dialog
 * stretches over the whole app window via one class, and comes back with a
 * second press. That keeps everything the dialogs rely on working untouched —
 * Obsidian hangs its menus, tooltips and notices on `<body>` outside any
 * fullscreen element, ESC keeps closing the dialog instead of leaving the
 * screen, and there is no overlay-carrying machinery to unwind.
 *
 * The state lives on the modal element itself, which Obsidian discards when the
 * dialog closes, so there is nothing to clean up and no flag to reset: a
 * reopened dialog always starts windowed.
 */
import { Modal, setIcon } from "obsidian";
import { h } from "./dom";
import { applyTooltip } from "./tooltip";
import { t } from "../i18n";

/** Stretches the dialog over the app window; see `styles.css`. */
const FULLSCREEN_CLASS = "mtk-modal-fullscreen";

/** Obsidian's `maximize` — the glyph the workspace focus mode already uses. */
const ICON_ENTER = "maximize";
const ICON_EXIT = "minimize-2";

/**
 * Obsidian's own class for the `×`; we copy its box and its place.
 *
 * The `:not()` keeps this on the native button even though the toggle is built
 * from the same parent: the two must never be confused for one another.
 */
const CLOSE_SELECTOR = ".modal-close-button:not(.mtk-modal-fullscreen-btn)";

/**
 * Breathing room between the toggle and the close button it sits beside.
 *
 * One full step on Obsidian's scale (`--size-4-2`), and repeated as the fallback
 * in `styles.css` — the two must stay in step. Measured against the native pair:
 * at 4 the two hover backgrounds read as one smudged block, at 12 they stop
 * reading as a pair at all; 8 leaves them clearly separate while still grouped.
 */
const GAP = 8;

/** Adds the toggle button to a dialog. Call once from `onOpen`. */
export function attachFullscreenToggle(modal: Modal): void {
  const { modalEl } = modal;
  const button = h("button", {
    cls: "mtk-modal-fullscreen-btn clickable-icon",
    attr: { type: "button" },
  });
  setIcon(button, ICON_ENTER);
  applyTooltip(button, t("modal.fullscreen"));

  button.addEventListener("click", () => {
    const expanded = modalEl.classList.toggle(FULLSCREEN_CLASS);
    setIcon(button, expanded ? ICON_EXIT : ICON_ENTER);
    applyTooltip(button, expanded ? t("modal.fullscreenExit") : t("modal.fullscreen"));
  });

  // A direct child of the modal shell, like the close button it sits beside —
  // so it survives the panel redrawing everything inside `contentEl`.
  modalEl.appendChild(button);
  mirrorCloseButton(modalEl, button);
  // The first read can land before the dialog has its final layout, and an
  // inline box outranks the stylesheet — so read again on the next frame, when
  // the `×` is certainly laid out. The button is gone if the dialog closed in
  // between, which is why the check leads.
  window.requestAnimationFrame(() => {
    if (button.isConnected) mirrorCloseButton(modalEl, button);
  });
}

/**
 * Places the toggle one gap to the inline-start of the native `×`, copying its
 * `top` and its whole box — `width` as well as `height` — so the two share a row
 * and, hovering, paint the same square.
 *
 * Everything positional comes off the two *laid-out* elements rather than off
 * the `×`'s declarations, and that is the point. The stylesheet can only hold
 * one fallback number, and the app has more than one layout: `body.styled-scrollbars`
 * moves the close button from 6 px to 12 px off the edge, so a fallback tuned
 * for one of them sits 6 px wrong on the other — 6 px being enough to make the
 * two hover backgrounds overlap. Reading the `×`'s *declared* inset is no better:
 * a theme may pin it with the physical `right` and leave `inset-inline-end` at
 * `auto`, and then the declaration describes nothing at all. Two rectangles and
 * a subtraction have neither problem, because they are what the user is looking
 * at.
 *
 * Measuring beats guessing on the box as well: the `×` is sized from
 * `svg.svg-icon`'s `--icon-size`, which resolves to `--icon-m` on desktop and
 * `--icon-xs` on touch, and its box grows by the same amount. One computed-style
 * read covers every layout.
 *
 * `width` is copied alongside `height` and not left to the stylesheet, because
 * the toggle is a `<button>` and the `×` is a `<div>`. `app.css` zeroes the
 * button border (`button { border: 0 }`), so the two boxes have the same
 * content-and-padding width — but that is the app's rule, not ours, and a theme
 * that paints a button border would swell the toggle alone by 4 px, which is
 * enough to push its hover square into the `×`'s. Taking the measured box makes
 * the size independent of whose rule is winning.
 *
 * Safe to measure now — Obsidian appends the dialog to the document *before* it
 * calls `onOpen`, so the `×` is already laid out. If a future version reorders
 * that, or a theme removes the button, the stylesheet's own fallback values
 * still place the toggle sensibly; the second pass above covers a first read
 * that landed too early.
 */
function mirrorCloseButton(modalEl: HTMLElement, button: HTMLElement): void {
  const close = modalEl.querySelector<HTMLElement>(CLOSE_SELECTOR);
  if (!close) return;

  const closeStyle = getComputedStyle(close);
  button.style.top = closeStyle.top;
  button.style.width = closeStyle.width;
  button.style.height = closeStyle.height;

  const modalStyle = getComputedStyle(modalEl);
  const modalRect = modalEl.getBoundingClientRect();
  const closeRect = close.getBoundingClientRect();
  const rtl = modalStyle.direction === "rtl";
  // An absolutely positioned child is placed inside the modal's *padding* box,
  // while the border sits outside it — so it has to come off the edge the insets
  // are actually measured from.
  const border = parseFloat(rtl ? modalStyle.borderLeftWidth : modalStyle.borderRightWidth) || 0;
  const paddingBoxEnd = modalRect.right - border;

  if (rtl) {
    // The `×` is on the left there, so a slot further from that edge is the
    // inline-start one. Writing both sides keeps the pair from straddling the
    // box (an absolutely positioned element with both insets set stretches).
    button.style.insetInlineEnd = "auto";
    button.style.insetInlineStart = `${paddingBoxEnd - closeRect.right + GAP}px`;
  } else {
    button.style.insetInlineStart = "auto";
    button.style.insetInlineEnd = `${paddingBoxEnd - closeRect.left + GAP}px`;
  }
}
