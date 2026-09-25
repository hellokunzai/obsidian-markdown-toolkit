/**
 * The custom order: which of a folder's subfolders come first, and everything
 * that keeps that record true as the vault changes underneath it.
 *
 * Five decisions shape this file.
 *
 * 1. The record is keyed by folder, and holds **names, not paths**. Within one
 *    folder a name is unique, it is shorter, and moving a folder carries its
 *    children's order along with it without touching a single entry. The cost
 *    is that renames have to be followed, which is what the vault handlers are
 *    for.
 *
 * 2. **Folders only.** Files stay exactly where the sort menu puts them.
 *
 *    The explorer draws every folder above every file and orders folders by
 *    name, so the two kinds occupy two separate runs of slots and "this note
 *    above that folder" is not a position that exists. The first version of
 *    this feature answered that with one list per kind; what it actually did
 *    was let two things decide one list — the record for whatever had been
 *    dragged, the sort menu for the rest — and the file half was never what
 *    anyone reached for this feature for. Arranging folders alone needs one
 *    list per folder, and it leaves the sort menu in charge of the half it
 *    already handles well.
 *
 * 3. Absent means "let Obsidian sort it". A folder appears in the record only
 *    once one of its subfolders has been dragged — so a vault where the feature
 *    was never used stores nothing, and an untouched folder keeps following the
 *    sort menu exactly as before. The patch is a pass-through for every folder
 *    but the ones arranged by hand.
 *
 * 4. Nothing is ever rebuilt as "folders, then files". Subfolders are written
 *    back into the very slots they arrived in, so the file run below them is
 *    never touched and switching the sort menu still visibly reorders
 *    everything this file has no opinion about.
 *
 * 5. Subfolders the record has never seen — created since, or moved in from
 *    elsewhere — sink below the arranged ones and keep their relative order.
 *    That makes a newly created folder show up at the bottom of its parent
 *    rather than at an arbitrary point in the middle, and it is also what keeps
 *    `move()` total: both names it is given are always in the record, because
 *    the record is re-frozen from what is displayed before every drag.
 */

import { TAbstractFile, TFolder } from "obsidian";
import type { FileTreeItem } from "./explorer-sort";

/** Every arranged folder, keyed by its path, holding its subfolders in order. */
export type Orders = Record<string, string[]>;

/**
 * The vault root's key.
 *
 * Obsidian calls it `/` — the root `TFolder` reports that as its own path — and
 * it is stored verbatim rather than translated to `""`, so there is one less
 * conversion between what the explorer hands over and what is written down.
 */
export const ROOT_KEY = "/";

/** The folder a path sits in. A top-level path's parent is the vault root. */
export function parentKey(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? ROOT_KEY : path.slice(0, cut) || ROOT_KEY;
}

/** The last path segment, which is the name a record matches on. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

export interface MigratedOrders {
  orders: Orders;
  /** Whether anything had to be converted, so the caller knows to save. */
  migrated: boolean;
}

/**
 * Read a stored `orderMap`, whichever shape it is in.
 *
 * Three shapes have been stored. The oldest kept one flat list per folder,
 * mixing files and folders and keying the vault root as `""`; the flat list is
 * already this shape, so it is read as it stands and the file names inside it
 * are cleared by `prune` once the vault is up. The next kept a list per kind,
 * and only its folder list is read — see decision 2.
 */
export function migrateOrders(raw: unknown): MigratedOrders {
  const orders: Orders = {};
  if (typeof raw !== "object" || raw === null) return { orders, migrated: false };

  let migrated = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = key === "" ? ROOT_KEY : key;
    if (key !== path) migrated = true;

    if (Array.isArray(value)) {
      const flat = names(value);
      if (flat.length > 0) orders[path] = flat;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;

    /* A record with no folders in it is dropped rather than kept empty, which
       is what a vault that had only ever dragged files keeps: an empty list
       says exactly what no record says, and this way nothing has to act on it. */
    migrated = true;
    const folders = names((value as Record<string, unknown>).folders);
    if (folders.length > 0) orders[path] = folders;
  }
  return { orders, migrated };
}

/**
 * Just the settings, deliberately. This class changes the record in memory and
 * never writes it — when to persist is the plugin's call, and keeping that out
 * of here means a drag can move a row and save once, rather than each helper
 * reaching for disk on its own.
 */
interface OrderHost {
  settings: { orderMap: Orders };
}

/** Sort `items` by their name's position in `order`, unrecorded ones last. */
function sortByRank(items: FileTreeItem[], order: string[]): FileTreeItem[] {
  if (order.length === 0) return items;

  /* A Map rather than repeated indexOf: this runs on every redraw of every
     folder, and indexOf would make it quadratic in the folder's size. */
  const rank = new Map<string, number>();
  order.forEach((name, index) => rank.set(name, index));

  return items.sort((a, b) => {
    const ra = rank.get(a.file.name);
    const rb = rank.get(b.file.name);

    /* Returning 0 between two unrecorded items hands the decision back to
       Array.sort's stability, so they keep whatever relative order Obsidian
       just gave them instead of landing in an arbitrary one. */
    if (ra === undefined || rb === undefined) {
      if (ra === undefined && rb === undefined) return 0;
      return ra === undefined ? 1 : -1;
    }
    return ra - rb;
  });
}

export class OrderStore {
  constructor(private readonly host: OrderHost) {}

  private get orders(): Orders {
    return this.host.settings.orderMap;
  }

  /**
   * The sort patch's whole job.
   *
   * A folder with no record — or one whose record holds nothing — is handed
   * straight back, which is what keeps this a shuffle over Obsidian's own
   * sorting rather than a replacement for it: whatever the user picked in the
   * sort menu still decides everything this plugin has no opinion about.
   *
   * The subfolders are gathered up along with the slot indices they arrived on,
   * sorted among themselves, and written back into those same slots — see
   * decision 4 for why rebuilding the array would be wrong. Everything else in
   * `sorted` is left alone, by position.
   */
  apply(folder: TFolder, sorted: FileTreeItem[]): FileTreeItem[] {
    const order = this.orders[folder.path];
    /* An empty record says exactly what no record says — "let Obsidian sort
       this folder" — so it is handed back untouched rather than copied. Nothing
       creates one, but `migrateOrders` can leave one behind when it reads a
       shape it does not understand, and `prune` only runs once the vault is up. */
    if (!order || order.length === 0) return sorted;

    const slots: number[] = [];
    const items: FileTreeItem[] = [];
    sorted.forEach((item, index) => {
      if (item.file instanceof TFolder) {
        slots.push(index);
        items.push(item);
      }
    });

    /* One subfolder has only one place it can be, and none at all is a folder
       whose only children are files. */
    if (items.length < 2) return sorted;

    const ranked = sortByRank(items, order);
    const out = sorted.slice();
    slots.forEach((slot, index) => (out[slot] = ranked[index]));
    return out;
  }

  /**
   * Freeze what is on screen right now, for one folder.
   *
   * Called before every drag, not just the first one. A drag is expressed as
   * "put this name next to that one", so both names have to be in the record
   * for the move to mean anything — and a folder added since the last drag is
   * not, until this runs. Re-freezing rather than capturing once is what keeps
   * `move()` total.
   *
   * The caller passes the order as *displayed* (Obsidian's order with this
   * record already laid over it), not the raw one, so the drag rearranges the
   * list the user is actually looking at.
   */
  capture(folderPath: string, displayed: string[]): void {
    /* An empty list would still count as a record, and every later apply()
       would then walk a folder it has nothing to say about. */
    if (displayed.length === 0) return;
    this.orders[folderPath] = displayed.slice();
  }

  /**
   * Move `moving` to sit before or after `target`, both subfolders of the same
   * folder. This plugin never reorders across folders, and never moves anything
   * on disk.
   */
  move(folderPath: string, moving: string, target: string, position: "before" | "after"): void {
    const order = this.orders[folderPath];
    if (!order || moving === target) return;

    const from = order.indexOf(moving);
    if (from === -1) return;
    order.splice(from, 1);

    /* Read the target's index *after* the removal, not before: pulling the
       moving item out shifts everything below it up by one, and an index taken
       beforehand would drop the row one place too low on every downward move. */
    const to = order.indexOf(target);
    if (to === -1) {
      order.splice(from, 0, moving);
      return;
    }
    order.splice(position === "before" ? to : to + 1, 0, moving);
  }

  /* ── Keeping the record true ─────────────────────────────────────────── */

  /* Both handlers report whether they actually changed anything, so the plugin
     can skip writing data.json for the common case: a record holds names only,
     and most of what happens in a vault is edits and new files, neither of
     which this has any reason to react to. A file that is deleted or renamed
     finds no name to move and says so, which is the answer wanted: only folders
     are ever recorded. */

  onDelete(file: TAbstractFile): boolean {
    const removed = this.removeName(parentKey(file.path), file.name);
    return this.dropSubtree(file.path) || removed;
  }

  /**
   * Rename covers three different events, because Obsidian reports a move and a
   * rename as the same thing: a name change in place, a move to another folder,
   * and — when the renamed item is itself a folder — a re-keying of every
   * record at or below it.
   */
  onRename(file: TAbstractFile, oldPath: string): boolean {
    const oldParent = parentKey(oldPath);
    const newParent = parentKey(file.path);
    const oldName = nameOf(oldPath);
    let changed = false;

    if (oldParent === newParent) {
      /* Renamed in place: keep the position, just change the label. */
      changed = this.renameName(oldParent, oldName, file.name);
    } else {
      /* Moved somewhere else. It leaves the old parent's record and does not
         join the new one's: a folder arriving from elsewhere is in exactly the
         position of one that was just created, and apply() sinks both to the
         bottom of their parent's list until the user says otherwise. */
      changed = this.removeName(oldParent, oldName);
    }

    if (file instanceof TFolder) {
      changed = this.rekeySubtree(oldPath, file.path) || changed;
    }
    return changed;
  }

  /**
   * Records that no longer describe anything — arranged folders that have been
   * deleted outside Obsidian, names of subfolders that are gone or that turned
   * out to be files, or leftovers from a version that stored something this one
   * does not. Run once, after the vault is loaded: cheap, and it stops data.json
   * growing scar tissue.
   *
   * Reports whether anything went, so a normal start does not rewrite data.json
   * just to save an unchanged file.
   */
  prune(folderFor: (path: string) => TFolder | null): boolean {
    let changed = false;

    for (const path of Object.keys(this.orders)) {
      const record = this.orders[path];
      const folder = folderFor(path);

      if (!folder) {
        /* The vault root always exists, so a missing folder here means a real
           one that is gone. */
        delete this.orders[path];
        changed = true;
        continue;
      }

      /* Folders only, so a name that is now a file is not something this record
         can be about — that is also how the oldest stored shape is cleared of
         the file names it used to mix in. */
      const live = new Set(
        folder.children.filter((child) => child instanceof TFolder).map((child) => child.name)
      );
      const kept = record.filter((name) => live.has(name));
      if (kept.length !== record.length) changed = true;

      if (kept.length === 0) delete this.orders[path];
      else this.orders[path] = kept;
    }
    return changed;
  }

  private removeName(folderPath: string, name: string): boolean {
    const order = this.orders[folderPath];
    if (!order) return false;
    const at = order.indexOf(name);
    if (at === -1) return false;
    order.splice(at, 1);
    return true;
  }

  private renameName(folderPath: string, oldName: string, newName: string): boolean {
    const order = this.orders[folderPath];
    if (!order) return false;
    const at = order.indexOf(oldName);
    if (at === -1) return false;
    order[at] = newName;
    return true;
  }

  private dropSubtree(path: string): boolean {
    const prefix = `${path}/`;
    let changed = false;
    for (const key of Object.keys(this.orders)) {
      if (key === path || key.startsWith(prefix)) {
        delete this.orders[key];
        changed = true;
      }
    }
    return changed;
  }

  private rekeySubtree(oldPath: string, newPath: string): boolean {
    const prefix = `${oldPath}/`;
    let changed = false;
    for (const key of Object.keys(this.orders)) {
      if (key !== oldPath && !key.startsWith(prefix)) continue;
      const moved = newPath + key.slice(oldPath.length);
      this.orders[moved] = this.orders[key];
      delete this.orders[key];
      changed = true;
    }
    return changed;
  }
}
