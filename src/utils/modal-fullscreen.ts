/**
 * The fullscreen toggle the editor panels carry in their toolbar, and the round
 * close-button styling every editor dialog uses.
 *
 * The mode the toggle drives is maximization rather than browser fullscreen: it
 * stretches the dialog over the whole app window via one class, and comes back
 * with a second press. That keeps everything the dialogs rely on working
 * untouched — Obsidian hangs its menus, tooltips and notices on `<body>` outside
 * any fullscreen element, ESC keeps closing the dialog instead of leaving the
 * screen, and there is no overlay-carrying machinery to unwind.
 *
 * The state lives on the modal element itself, which Obsidian discards when the
 * dialog closes, so there is nothing to clean up and no flag to reset: a
 * reopened dialog always starts windowed.
 */
import { setIcon } from "obsidian";
import { h } from "./dom";
import { applyTooltip } from "./tooltip";
import { t } from "../i18n";

/** Stretches the dialog over the app window; see `styles.css`. */
const FULLSCREEN_CLASS = "mtk-modal-fullscreen";

/** Obsidian's `maximize` — the glyph the workspace focus mode already uses. */
const ICON_ENTER = "maximize";
/** Matches the preview lightbox, which toggles `maximize` / `minimize`. */
const ICON_EXIT = "minimize";

/** Obsidian's own class for the dialog's `×`. */
const CLOSE_SELECTOR = ".modal-close-button";

/**
 * Gives the native `×` the round, lightbox styling the editor dialogs use.
 *
 * Every editor dialog calls this from `onOpen` — the main canvas window and each
 * of its sub-dialogs — so their close buttons read the same. The appearance
 * itself lives in `styles.css` under `.modal-close-button.mtk-modal-close-btn`.
 */
export function tagModalCloseButton(modalEl: HTMLElement): void {
  const closeButton = modalEl.querySelector<HTMLElement>(CLOSE_SELECTOR);
  if (closeButton) closeButton.classList.add("mtk-modal-close-btn");
}

/**
 * Builds the fullscreen toggle for the editor panels' toolbar.
 *
 * The panel is the same DOM whether it is shown in a dialog or a tab, so the
 * button finds its dialog at click time: it walks up to the nearest `.modal` and
 * toggles `.mtk-modal-fullscreen` there. In a tab there is no `.modal` ancestor
 * and the click is a no-op; the panel hides the button in that case via
 * `.mtk-in-tab .mtk-fullscreen` in CSS.
 */
export function buildFullscreenToolbarButton(): HTMLButtonElement {
  const button = h("button", {
    cls: "mtk-tb mtk-tb-icon-btn mtk-fullscreen",
    attr: { type: "button", "aria-label": t("modal.fullscreen") },
  });
  const icon = h("span", { cls: "mtk-tb-icon" });
  setIcon(icon, ICON_ENTER);
  button.appendChild(icon);
  applyTooltip(button, t("modal.fullscreen"));

  button.addEventListener("click", () => {
    const modalEl = button.closest<HTMLElement>(".modal");
    if (!modalEl) return;
    const expanded = modalEl.classList.toggle(FULLSCREEN_CLASS);
    setIcon(icon, expanded ? ICON_EXIT : ICON_ENTER);
    applyTooltip(button, expanded ? t("modal.fullscreenExit") : t("modal.fullscreen"));
  });
  return button;
}
