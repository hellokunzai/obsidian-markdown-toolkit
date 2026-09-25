/**
 * Tooltips.
 *
 * Obsidian's tooltip system reads `aria-label` — `setTooltip` is the supported
 * way to write it (`@since 1.4.4`, below this plugin's minimum app version).
 * A native `title` attribute is invisible to that system and falls through to
 * the operating system's own plain text box, which looks nothing like the themed
 * bubbles next to it. So every hint in this plugin goes through here.
 */
import { setTooltip } from "obsidian";

export function applyTooltip(el: HTMLElement, text: string): void {
  setTooltip(el, text);
}
