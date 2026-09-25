/**
 * The custom order: which entries of a folder come in which order, and
 * everything that keeps that record true as the vault changes underneath it.
 *
 * Five decisions shape this file.
 *
 * 1. The record is keyed by folder, and holds **names, not paths**. Within one
 *    folder a name is unique, it is shorter, and moving a folder carries its
 *    children's order along without touching a single entry. The cost is that
 *    renames have to be followed, which is what the vault handlers are for.
 *
 * 2. Folders and files are ordered **separately**, each inside the run of slots
 *    it already occupies — which is why the record has two lists rather than
 *    one. The explorer always draws folders above files and always orders
 *    folders by name, so "this file above that folder" is not a position that
 *    exists, and a single mixed list could only ever misrepresent one of the
 *    two. Keeping them apart also means dragging one note does not freeze the
 *    folder list, or the other way round: only the kind you actually arranged
 *    stops following the sort menu.
 *
 * 3. Absent means "let Obsidian sort it". An entry appears for a folder only
 *    once something in it has been dragged, and only for the kind that was
 *    dragged — so a vault where the feature was never used stores nothing, and
 *    an untouched folder keeps following the sort menu exactly as before. The
 *    patch is a pass-through for every folder but the ones arranged by hand.
 *
 * 4. Nothing is ever rebuilt as "folders, then files". Items are written back
 *    into the very slots they arrived in, so whatever grouping the explorer
 *    applied survives untouched, and switching the sort menu still visibly
 *    reorders everything this file has no opinion about.
 *
 * 5. Entries the record has never seen — created since, or moved in from
 *    elsewhere — sink below the arranged ones and keep their relative order.
 *    That makes a newly created note show up at the bottom of its folder's
 *    files rather than at an arbitrary point in the middle, and it is also what
 *    keeps `move()` total: both names it is given are always in the record,
 *    because the record is re-frozen from what is displayed before every drag.
 */

import { TAbstractFile, TFile, TFolder } from "obsidian";
import type { FileTreeItem } from "./explorer-sort";

/** Which of a folder's two ordered lists something belongs to. */
export type ItemKind = "folders" | "files";

/** One folder's record: two independent orders, one per kind. */
export interface FolderOrder {
  folders: string[];
  files: string[];
}

/** Every arranged folder, keyed by its path. The vault root is `/`. */
export type Orders = Record<string, FolderOrder>;

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

/** Which list a file belongs in. Everything that is not a folder is a file. */
export function kindOf(file: TAbstractFile): ItemKind {
  return file instanceof TFolder ? "folders" : "files";
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
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
 * The first version of this feature kept one flat list per folder, mixing files
 * and folders, and keyed the vault root as `""`. Both are converted here.
 *
 * The old flat list cannot be split by kind without asking the vault, and this
 * runs while settings load — before the vault is guaranteed to be readable. It
 * does not need to be split: only the *relative* order within each kind decides
 * anything, and a flat list holds that relative order for both kinds already.
 * So the same names are written into both lists. Entries that no longer match
 * anything are ignored by `apply` and cleared by `prune`, which runs once the
 * vault is up.
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
      orders[path] = { folders: flat, files: flat.slice() };
      migrated = true;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;

    const record = value as Record<string, unknown>;
    const folders = isNameList(record.folders) ? names(record.folders) : [];
    const files = isNameList(record.files) ? names(record.files) : [];
    orders[path] = { folders, files };
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
   * sorting rather than a replacement for it:
   * whatever the user picked in the sort menu still decides everything this
   * plugin has no opinion about.
   *
   * Each kind is gathered up along with the slot indices it arrived on, sorted
   * among itself, and written back into those same slots — see decision 4 in
   * the header for why rebuilding the array would be wrong.
   */
  apply(folder: TFolder, sorted: FileTreeItem[]): FileTreeItem[] {
    const record = this.orders[folder.path];
    /* An empty record says exactly what no record says — "let Obsidian sort
       this folder" — so it is handed back untouched rather than copied. Nothing
       creates one, but `migrateOrders` can leave one behind when it reads a
       shape it does not understand, and `prune` only runs once the vault is up. */
    if (!record || (record.folders.length === 0 && record.files.length === 0)) return sorted;

    const folderSlots: number[] = [];
    const folderItems: FileTreeItem[] = [];
    const fileSlots: number[] = [];
    const fileItems: FileTreeItem[] = [];

    sorted.forEach((item, index) => {
      if (item.file instanceof TFolder) {
        folderSlots.push(index);
        folderItems.push(item);
      } else if (item.file instanceof TFile) {
        fileSlots.push(index);
        fileItems.push(item);
      }
    });

    /* One item of a kind has only one place it can be. */
    const out = sorted.slice();
    this.place(out, folderSlots, sortByRank(folderItems, record.folders));
    this.place(out, fileSlots, sortByRank(fileItems, record.files));
    return out;
  }

  private place(out: FileTreeItem[], slots: number[], items: FileTreeItem[]): void {
    slots.forEach((slot, index) => (out[slot] = items[index]));
  }

  /**
   * Freeze what is on screen right now, for one kind of one folder.
   *
   * Called before every drag, not just the first one. A drag is expressed as
   * "put this name next to that one", so both names have to be in the record
   * for the move to mean anything — and an entry added to the folder since the
   * last drag is not, until this runs. Re-freezing rather than capturing once
   * is what keeps `move()` total.
   *
   * The caller passes the order as *displayed* (Obsidian's order with this
   * record already laid over it), not the raw one, so the drag rearranges the
   * list the user is actually looking at.
   */
  capture(folderPath: string, kind: ItemKind, displayed: string[]): void {
    /* An empty list would still count as a record, and every later apply()
       would then walk a folder it has nothing to say about. */
    if (displayed.length === 0) return;

    const record = this.orders[folderPath] ?? { folders: [], files: [] };
    record[kind] = displayed.slice();
    this.orders[folderPath] = record;
  }

  /**
   * Move `moving` to sit before or after `target`, both names of the same kind
   * in the same folder. This plugin never reorders across folders, and never
   * moves anything on disk.
   */
  move(
    folderPath: string,
    kind: ItemKind,
    moving: string,
    target: string,
    position: "before" | "after"
  ): void {
    const record = this.orders[folderPath];
    if (!record || moving === target) return;

    const order = record[kind];
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
     which this has any reason to react to. */

  onDelete(file: TAbstractFile): boolean {
    const removed = this.removeName(parentKey(file.path), file.name, kindOf(file));
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
      changed = this.renameName(oldParent, oldName, file.name, kindOf(file));
    } else {
      /* Moved somewhere else. It leaves the old parent's record and does not
         join the new one's: a folder or note arriving from elsewhere is in
         exactly the position of one that was just created, and apply() sinks
         both to the bottom of their kind's run until the user says otherwise. */
      changed = this.removeName(oldParent, oldName, kindOf(file));
    }

    if (file instanceof TFolder) {
      changed = this.rekeySubtree(oldPath, file.path) || changed;
    }
    return changed;
  }

  /**
   * Records that no longer describe anything — arranged folders that have been
   * deleted outside Obsidian, names of entries that are gone, or leftovers from
   * a version that stored something this one does not. Run once, after the
   * vault is loaded: cheap, and it stops data.json growing scar tissue.
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

      const live = new Set(folder.children.map((child) => child.name));
      const folders = record.folders.filter((name) => live.has(name));
      const files = record.files.filter((name) => live.has(name));
      if (folders.length !== record.folders.length || files.length !== record.files.length) {
        changed = true;
      }

      if (folders.length === 0 && files.length === 0) {
        delete this.orders[path];
      } else {
        this.orders[path] = { folders, files };
      }
    }
    return changed;
  }

  private removeName(folderPath: string, name: string, kind: ItemKind): boolean {
    const record = this.orders[folderPath];
    if (!record) return false;
    const at = record[kind].indexOf(name);
    if (at === -1) return false;
    record[kind].splice(at, 1);
    return true;
  }

  private renameName(folderPath: string, oldName: string, newName: string, kind: ItemKind): boolean {
    const record = this.orders[folderPath];
    if (!record) return false;
    const at = record[kind].indexOf(oldName);
    if (at === -1) return false;
    record[kind][at] = newName;
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
