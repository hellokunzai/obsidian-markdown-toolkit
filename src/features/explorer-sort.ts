/**
 * The file explorer's own way of ordering its rows.
 *
 * None of this is in `obsidian.d.ts`. The explorer view keeps a `fileItems`
 * map of every row it has ever built, and its prototype carries the method
 * that turns a folder's children into the array of rows the tree then lays
 * out. That method is the one seam worth using, and using it is the whole
 * point of this file: reordering the DOM instead fights the explorer instead
 * of talking to it.
 *
 * What the real implementation does (app.js, Obsidian 1.13.7 — read from the
 * installed `obsidian.asar`, not guessed):
 *
 *     getSortedFolderItems(folder) {
 *       const cmp = comparatorFor(this.sortOrder);
 *       const children = folder.children.slice();
 *       children.sort((a, b) => {
 *         const af = a instanceof TFolder, bf = b instanceof TFolder;
 *         return af || bf
 *           ? (af && !bf ? -1 : bf && !af ? 1 : compareNames(a.name, b.name))
 *           : cmp(a, b);
 *       });
 *       return children.map((f) => this.fileItems[f.path]).filter(Boolean);
 *     }
 *
 * Three facts follow from that, and every feature built on top of this file
 * depends on them:
 *
 * 1. Folders always come first, and folders are always ordered by name — the
 *    sort menu the user picks only ever re-orders files. So within one folder
 *    the two kinds occupy two separate runs of slots, and "put this folder
 *    after that file" is not a position that exists.
 *
 * 2. The `fileItems` lookup is not a lazy render cache: the view fills that map
 *    from `vault.getAllLoadedFiles()` up front and keeps it level through
 *    `onCreate` / `onRename` / `onDelete`. The array handed back is therefore
 *    the folder's *complete* child list, not the slice currently on screen.
 *    (The DOM is the virtualised thing — a long folder has most of its rows
 *    absent from the document.)
 *
 * 3. The returned array is what the tree renders. Returning a reordered copy is
 *    the supported way to reorder rows; nothing needs to be touched in the DOM.
 *
 * The patch goes on the *prototype* rather than on one view, so a second
 * explorer leaf — a sidebar popped out into its own window, or one opened
 * later — is covered without extra bookkeeping. The returned `unpatch` is
 * therefore not optional: a closure from an unloaded plugin left sitting on
 * Obsidian's prototype would keep running after the plugin is gone.
 *
 * Everything here is guarded. A future Obsidian is free to rename any of it,
 * and when that happens the feature switches itself off instead of throwing.
 */

import type { TAbstractFile, TFolder } from "obsidian";

/**
 * One row as the explorer's sorter hands it over.
 *
 * The real object is an `ExplorerItem` with a great deal more on it — the row
 * element, its collapse state, its title. Only `file` is read here, because
 * only `file` is what an order is ever expressed in terms of.
 */
export interface FileTreeItem {
  file: TAbstractFile;
}

/**
 * What the explorer's prototype must have for the patch to mean anything.
 *
 * Both members are function-typed properties rather than methods, and both
 * declare their `this`. The `this` is the contract: this file takes the sorter
 * off the prototype and calls it with a receiver of its own choosing, and saying
 * so in the type is what makes that a stated part of the design rather than an
 * accident that happens to work. Writing them as properties rather than methods
 * is what lets the sorter be read off the prototype at all — a method reference
 * separated from its object is exactly what the linter is there to catch, and
 * there is nothing to catch here, because every call site supplies the receiver
 * itself.
 */
interface SortableProto {
  sort: (this: SortableProto) => void;
  getSortedFolderItems: (this: SortableProto, folder: TFolder) => FileTreeItem[];
}

function isSortable(proto: unknown): proto is SortableProto {
  if (typeof proto !== "object" || proto === null) return false;
  const candidate = proto as Record<string, unknown>;
  return (
    typeof candidate.sort === "function" &&
    typeof candidate.getSortedFolderItems === "function"
  );
}

export interface SortPatch {
  /** Put the original method back. Called when the feature is switched off. */
  unpatch(): void;
  /**
   * A folder's children in Obsidian's own order, straight from the unpatched
   * method.
   *
   * Needed because an order has to be re-frozen from what is on screen before
   * every drag, and the screen cannot supply that — see fact 2 above. Asking
   * the sorter gives the whole child list whether or not any of it is rendered.
   */
  nativeItems(folder: TFolder): FileTreeItem[];
}

/**
 * Replace the explorer prototype's sorter with `reorder`, which is handed the
 * original result to shuffle or to pass straight back.
 *
 * Returns `null` when this build of Obsidian does not have the methods, which
 * is the caller's signal to leave custom ordering switched off entirely rather
 * than to record an order nothing will ever apply.
 */
export function patchSorting(
  view: unknown,
  reorder: (folder: TFolder, sorted: FileTreeItem[]) => FileTreeItem[]
): SortPatch | null {
  if (typeof view !== "object" || view === null) return null;

  const proto: unknown = Object.getPrototypeOf(view);
  if (!isSortable(proto)) return null;

  /* Taken off the prototype and always called with an explicit receiver — see
     the `this` parameters on `SortableProto`. Reading it is what "keep the old
     one around to call" means; the receiver is never the thing that gets lost
     here, because every call below supplies one. */
  const original = proto.getSortedFolderItems;

  proto.getSortedFolderItems = function (
    this: SortableProto,
    folder: TFolder
  ): FileTreeItem[] {
    return reorder(folder, original.call(this, folder));
  };

  const host = view as unknown as SortableProto;
  return {
    unpatch: () => {
      proto.getSortedFolderItems = original;
    },
    nativeItems: (folder: TFolder) => original.call(host, folder),
  };
}

/**
 * Ask the explorer to lay its rows out again.
 *
 * Guarded rather than assumed: this redraw is what makes a reordering appear,
 * but failing to find it must not throw — worst case the new order shows up the
 * next time the tree rebuilds on its own.
 */
export function sortView(view: unknown): void {
  const candidate = view as { sort?: unknown } | null;
  if (candidate && typeof candidate.sort === "function") {
    (candidate.sort as () => void).call(view);
  }
}
