/**
 * Reading paths out of the file explorer's DOM.
 *
 * Two things about that markup are easy to get wrong, and both fail silently —
 * a query that matches nothing looks exactly like a query whose rules matched
 * nothing.
 *
 * 1. `data-path` lives on the **title**, not on the row wrapper:
 *
 *        <div class="tree-item nav-folder">                                    <- wrapper
 *          <div class="tree-item-self nav-folder-title is-clickable" data-path="…">  <- title
 *          <div class="tree-item-children nav-folder-children">…</div>
 *
 *    That split is not a detail of one version: the shared item constructor
 *    creates the two elements separately —
 *    `this.el = createDiv("tree-item"); this.selfEl = el.createDiv("tree-item-self")` —
 *    and the explorer item then writes its path with
 *    `this.selfEl.setAttr("data-path", this.file.path)`.
 *
 * 2. The rows live in the view's **`containerEl`**, not in its `contentEl`.
 *    Obsidian's view base builds `contentEl` as `containerEl.createDiv("view-content")`,
 *    but the file explorer puts nothing in it: it creates its nav header and its
 *    `.nav-files-container` as *further children of `containerEl`*, so
 *    `contentEl` is an empty sibling of the tree. Anything querying rows through
 *    `contentEl` therefore finds zero of them, forever and without a warning.
 *
 * Both the row selector and the title lookup below exist so that this knowledge
 * lives in exactly one place.
 */

import type { WorkspaceLeaf } from "obsidian";

/**
 * Every hideable row: a file or folder item inside an explorer, at any depth.
 *
 * Deliberately not `.nav-folder-children > .nav-file`: the rows are nested
 * under whichever folder contains them, and a `>` chain would have to be
 * repeated for every level. Scoping to `.nav-files-container` is what keeps the
 * match inside the explorer.
 *
 * The vault-root folder row matches too — it is a `.nav-folder` like any other.
 * It never hides itself, because its path is empty and so its name is: see the
 * empty-name guard in `HideRules.apply`.
 */
export const EXPLORER_ITEM_SELECTOR =
  ".nav-files-container .nav-file, .nav-files-container .nav-folder";

/**
 * The element an explorer renders its rows into.
 *
 * It is the view's `containerEl`. This is the one line that has to be shared:
 * every feature that walks the tree needs the same answer, and getting it wrong
 * produces an empty result rather than an error — see point 2 in the header.
 * Read structurally rather than through a cast of the whole view, because no
 * explorer view type is exported to cast to.
 */
export function explorerRootEl(leaf: WorkspaceLeaf): HTMLElement | null {
  const view = leaf.view as unknown as { containerEl?: HTMLElement };
  return view.containerEl ?? null;
}

/** The title element of an item, addressed as a direct child so that a folder
 * cannot accidentally resolve to one of its descendants' titles. */
const TITLE_SELECTOR = ":scope > .nav-file-title, :scope > .nav-folder-title";

/** The element that carries `data-path`, falling back to the item itself. */
export function itemTitle(item: HTMLElement): HTMLElement {
  return item.querySelector<HTMLElement>(TITLE_SELECTOR) ?? item;
}

/** The vault path (`folder/note.md`) of an item, or `""` when there is none. */
export function itemPath(item: HTMLElement): string {
  return item.getAttribute("data-path") ?? itemTitle(item).getAttribute("data-path") ?? "";
}

/** The last path segment, which is the name a rule matches on. */
export function itemName(item: HTMLElement): string {
  return itemPath(item).split("/").pop() ?? "";
}

/** The vault path of the folder a `.nav-folder-children` container belongs to. */
export function containerFolderPath(container: HTMLElement): string {
  const folder = container.closest<HTMLElement>(".nav-folder");
  return folder ? itemPath(folder) : "";
}
