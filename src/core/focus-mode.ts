/**
 * Fullscreen focus mode: which element to blow up, and what has to come along.
 *
 * The reference plugin (`obsidian-editing-toolbar`) calls this "fullscreen focus
 * mode", and its effect comes from *what it makes fullscreen*: the root tab
 * container, the box the open note is drawn in. Everything around that box —
 * the title bar, the ribbon, both sidebars, the tab strip, the status bar — is
 * outside it, and a browser does not render the parts of a document that sit
 * outside the fullscreen element. So nothing has to be enumerated, hidden or
 * remembered: the surrounding interface goes away because it was never included.
 *
 * The cost of choosing that element is the rest of this file. Obsidian hangs
 * every overlay it owns on `<body>` — `Menu.showAtPosition` appends the menu and
 * its backdrop straight to `document.body`, and the tooltip, the modal
 * container, the notice container, the suggestion container and the hover
 * preview are appended there too — and a body child that is not inside the
 * fullscreen element is not rendered either. Left alone, the mode would take
 * the toolbar's own submenus, the swatch panel, the command palette and the
 * settings window down with it. So they are carried into the fullscreen element
 * while the mode is on, and put back when it ends.
 *
 * Kept apart from the feature so the two decisions this all rests on — where the
 * note lives, and what counts as an overlay — can be exercised without an app.
 */

/* ------------------------------------------------------------- the toolbar */

/** The toolbar entry's id, so the settings page can detect it. */
export const FOCUS_MODE_TOOL_ID = "focus-mode";

/**
 * The command a press ends in, and the one the command palette reaches directly.
 *
 * The toolbar runs it like any other command button: unlike the two colour
 * entries there is no panel to anchor, so nothing here needs a special case in
 * `features/editor-toolbar`.
 */
export const FOCUS_MODE_COMMAND_ID = "markdown-toolkit:toggle-focus-mode";

/**
 * The glyph the toolbar draws.
 *
 * Obsidian's own `maximize`, not `fullscreen`: the latter is the same four
 * corners with a rounded rectangle added inside them, and the icon this feature
 * is modelled on has no inner shape. Read off the reference screenshot, whose
 * ink box is 19x19 px with the left bracket reaching 7 px along the top edge and
 * a 5 px gap to the right one — `maximize`'s 7/20 and 5/20, where `scan`, the
 * other four-corner glyph in the set, is 6/20 and 7/20.
 */
export const FOCUS_MODE_ICON = "maximize";

/* ---------------------------------------------------- where the note lives */

/**
 * The element to make fullscreen, tried in order.
 *
 * A sidebar holds a `.workspace-tab-container` of its own, so "the first tab
 * container on the page" is not the same question as "the tab container the
 * note is in" — every selector here is anchored on the root split, and the last
 * one states the exclusion outright rather than relying on `mod-root` being
 * present.
 */
export const FOCUS_TARGET_SELECTORS: readonly string[] = [
  // The reference plugin's own selector.
  ".mod-vertical.mod-root .workspace-tab-container",
  // Stacked tabs put `mod-stacked` on the root split instead of `mod-vertical`.
  ".workspace-split.mod-root .workspace-tab-container",
  // Any split that is not a sidebar: covers layouts that renamed the root split,
  // and editors the user has split into panes, without ever reaching into a
  // sidebar.
  ".workspace-split:not(.mod-left-split):not(.mod-right-split) .workspace-tab-container",
];

/**
 * What gets carried into the fullscreen element.
 *
 * Every entry is a body child Obsidian creates, so a node matching one of them
 * is invisible the moment it sits outside the fullscreen element. The last entry
 * is this plugin's own panel, which is mounted on the body for the same reason
 * Obsidian's are.
 */
export const OVERLAY_SELECTORS: readonly string[] = [
  // What a toolbar submenu opens, plus the backdrop it puts behind itself (the
  // backdrop is what an outside click lands on to dismiss the menu).
  ".menu",
  ".suggestion-bg",
  // The hover label Obsidian reuses for every `aria-label` on the page.
  ".tooltip",
  // Dialogs: the settings window, the command palette, this plugin's text-tool
  // modal.
  ".modal-container",
  // The notices in the corner.
  ".notice-container",
  // Editor autocomplete.
  ".suggestion-container",
  // The link preview.
  ".hover-popover",
  // This plugin's swatch panel.
  ".mtk-color-panel",
];

/** The same list as one selector, for `matches` and `querySelectorAll`. */
export const OVERLAY_SELECTOR = OVERLAY_SELECTORS.join(", ");

/** The element to make fullscreen, or `null` when there is no note on screen. */
export function findFocusTarget(root: ParentNode): Element | null {
  for (const selector of FOCUS_TARGET_SELECTORS) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/**
 * Whether this node is one of the overlays that has to be carried in.
 *
 * `nodeType` rather than `instanceof Element`: the document can belong to a
 * popout window, whose constructors are not this window's, and an `instanceof`
 * across two windows is quietly false.
 */
export function isRelocatableOverlay(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  return (node as Element).matches(OVERLAY_SELECTOR);
}

/**
 * The overlays already on `root` — what was open when the mode began.
 *
 * Only the direct children, which is what the watcher started afterwards sees.
 * Descendants are deliberately out of scope: a `.menu` nested inside a dialog
 * belongs to that dialog and travels with it.
 */
export function collectOverlays(root: ParentNode): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(root.children)) {
    if (isRelocatableOverlay(child)) out.push(child);
  }
  return out;
}
