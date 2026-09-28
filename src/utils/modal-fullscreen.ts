/**
 * The fullscreen toggle in a dialog's top-right corner.
 *
 * Every editing dialog gets one, sitting left of the native close button. The
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

/** Obsidian's own class for the `×`; we copy its box. */
const CLOSE_SELECTOR = ".modal-close-button";

/** Breathing room between the toggle and the close button it sits beside. */
const GAP = 4;

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
}

/**
 * Copies the native close button's box onto the toggle and shifts it one gap
 * left, so the two glyphs share a row by construction rather than by matching
 * hard-coded numbers.
 *
 * Measuring beats guessing here: the `×` is sized from `--icon-xs`, which the
 * desktop theme sets to 14 px and touch layouts raise to 18, and its box grows
 * by the same amount. One computed-style read covers both.
 *
 * Safe to measure now — Obsidian appends the dialog to the document *before* it
 * calls `onOpen`, so the `×` is already laid out. If a future version reorders
 * that, or a theme removes the button, the stylesheet's own fallback values
 * still place the toggle sensibly.
 */
function mirrorCloseButton(modalEl: HTMLElement, button: HTMLElement): void {
  const close = modalEl.querySelector<HTMLElement>(CLOSE_SELECTOR);
  if (!close) return;

  const style = getComputedStyle(close);
  button.style.top = style.top;
  button.style.height = style.height;
  if (style.insetInlineEnd && style.insetInlineEnd !== "auto") {
    // Composed on the close button's own logical inset, so this mirrors
    // correctly under RTL as well.
    button.style.insetInlineEnd = `calc(${style.insetInlineEnd} + ${close.offsetWidth}px + ${GAP}px)`;
  }
}
