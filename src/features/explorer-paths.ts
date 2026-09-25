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
 * empty-name guard in `HideRules.apply`. (Measured on a live 1.12.7 explorer:
 * that version renders no root row at all — there is no `.mod-root` inside
 * `.nav-files-container`, and the row count equals the folder count. The guard
 * above stays because it costs nothing and a version that does render one needs
 * it; `isExplorerRoot` is a no-op there rather than a mistake.)
 */
export const EXPLORER_ITEM_SELECTOR =
  ".nav-files-container .nav-file, .nav-files-container .nav-folder";

/**
 * The folder rows alone.
 *
 * A folder row is a superset of the folder *wrapper*: `.nav-folder` carries the
 * whole subtree of the folder it names, and it is the element that occupies the
 * row's slot in the layout, which is what both decorating and hit-testing want.
 */
export const EXPLORER_FOLDER_SELECTOR = ".nav-files-container .nav-folder";

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

/**
 * Whether an item is the vault root.
 *
 * The root is drawn as an ordinary `.nav-folder` row — it is the one row that is
 * not *inside* anything, and its path is the vault's own, so it can be neither
 * hidden nor reordered. Read off `.mod-root` rather than off the path: which
 * path the root's row carries has never been worth relying on (its title is
 * written with the root folder's own path, and the root's name is the empty
 * string, so every path-shaped test either fails open or accidentally passes).
 * The class is what the explorer puts on it, and it is checked on both the
 * wrapper and the title because the two are built separately and only one of
 * them is guaranteed to carry it.
 */
export function isExplorerRoot(item: HTMLElement): boolean {
  return item.classList.contains("mod-root") || itemTitle(item).classList.contains("mod-root");
}

/** The vault path of the folder a `.nav-folder-children` container belongs to. */
export function containerFolderPath(container: HTMLElement): string {
  const folder = container.closest<HTMLElement>(".nav-folder");
  return folder ? itemPath(folder) : "";
}

/**
 * The element a row shares with its siblings — the parent, by definition.
 *
 * It is **not** `.nav-folder-children`, and that distinction cost a round of
 * work: only rows nested inside a folder sit in one of those. The top-level rows
 * hang off an anonymous scroll div, which is the *only* child of
 * `.nav-files-container`:
 *
 *     .nav-files-container.node-insert-event
 *       └─ <div class="">                      <- every top-level row lives here
 *            ├─ .tree-item.nav-folder          (measured: l56 r332 t86 b356)
 *            │    ├─ .tree-item-self.nav-folder-title[data-path]
 *            │    └─ .tree-item-children.nav-folder-children   (nested rows)
 *            └─ .tree-item.nav-file
 *
 * Read from a live 1.12.7 explorer over CDP, not from the asar template: the
 * template shows what a row is built from, and says nothing about where the
 * tree puts it. What follows is that `closest(".nav-folder-children")` answers
 * null for every top-level folder, and a caller that treats that as "no
 * container" refuses every drag of one, without a sound or a pixel to say so.
 *
 * The parent is also the better box to measure against: it spans the rows and
 * nothing else, where `.nav-files-container` carries the sidebar's padding and
 * whatever height the panel happens to have.
 */
export function rowContainer(row: HTMLElement): HTMLElement | null {
  return row.parentElement;
}

/**
 * The explorer's toolbar: the row of buttons above the tree.
 *
 * Read from the explorer's own constructor, which builds
 * `containerEl > .nav-header > .nav-buttons-container` and then drops one
 * `div.clickable-icon.nav-action-button` into it per header button. There is
 * one of these per leaf, and nothing else in an explorer carries the class, so
 * the class alone addresses it — and addressing it by the name Obsidian's own
 * stylesheet already uses is what keeps a rename of the header wrapper from
 * quietly costing a button rather than throwing.
 */
export const EXPLORER_NAV_BAR_SELECTOR = ".nav-buttons-container";

/** An explorer's toolbar, or null on a view that does not have one. */
export function explorerNavBar(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(EXPLORER_NAV_BAR_SELECTOR);
}
