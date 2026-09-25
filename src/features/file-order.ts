/**
 * Manual ordering in the file explorer.
 *
 * Where the order itself lives, and the rules that keep it true, are in
 * `order-store.ts`. Where the explorer's sorting is reached is in
 * `explorer-sort.ts`. What is left — and what this file is — is the wiring:
 * installing the patch, growing a handle on every folder, and running one drag.
 *
 * The patch is what makes the drag simple. Nothing here reorders a row: the
 * explorer asks the patched sorter for a folder's children, gets them back in
 * the recorded order, and lays out its own rows. A drop therefore ends with a
 * call to `sort()` and a save, and the DOM is never touched by hand.
 *
 * That matters more than it sounds. Reordering the DOM is not merely fragile,
 * it does not work: the explorer virtualises its rows, so a folder long enough
 * to scroll has most of its children absent from the document — a record taken
 * from the screen would hold only the part that happened to be in view, and
 * everything else would come back as never-seen and sink to the bottom. The
 * explorer's own child list is the only complete one, and `nativeItems()` is
 * how it is asked for.
 *
 * The one thing the DOM *is* used for is working out where the pointer is
 * pointing, which is a question about pixels and nothing else.
 *
 * Only folders get a handle. A note keeps whatever place the sort menu gives it
 * — see decision 2 in `order-store.ts` for why — so the handles on screen are
 * exactly the rows a drag can move, and there is no such thing here as picking
 * up a note.
 *
 * The way in is a button in the explorer's own toolbar, and what it switches is
 * a mode: pressing it grows a handle on every folder, pressing it again puts
 * them away. The setting behind that button decides whether the button is on
 * screen at all. What it deliberately does *not* decide is whether the recorded
 * order still holds — a tree that has been arranged stays arranged with the
 * button hidden, because hiding it takes away the ability to change the order
 * rather than the order itself. That is why the patch outlives the switch: it is
 * only released once there is nothing left for it to apply.
 *
 * Drags run on pointer events rather than on the HTML5 drag-and-drop API,
 * because HTML5 drag is already spoken for: Obsidian uses it for "drop this
 * note into that folder". Only the handle is interactive, only it starts a
 * gesture, and nothing here ever touches the file system — the worst a bug can
 * do is put a row in the wrong place in a list.
 *
 * Throughout the gesture, not one element is moved. A row is lifted with a
 * class and the landing spot is marked with an attribute, and both of those are
 * cosmetic: the reorder happens once, after the pointer is released. Moving a
 * node mid-gesture would be self-defeating — the pointer's own target leaving
 * the document is what makes a browser cancel the gesture, after which no
 * further `pointermove` and no `pointerup` ever arrives, and the drag dies
 * silently half-way.
 */

import { addIcon, Notice, setIcon, TFolder, type App } from "obsidian";
import { t } from "../i18n";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";
import {
  EXPLORER_FOLDER_SELECTOR,
  explorerNavBar,
  explorerRootEl,
  isExplorerRoot,
  itemPath,
  itemTitle,
  rowContainer,
} from "./explorer-paths";
import { patchSorting, sortView, type SortPatch } from "./explorer-sort";
import { nameOf, OrderStore, parentKey, ROOT_KEY } from "./order-store";
import type MarkdownEditorPlusPlugin from "../main";

/** The grip prepended to a folder's title row. */
const HANDLE_CLASS = "mtk-order-handle";
/** On the row being carried. */
const DRAGGING_CLASS = "mtk-order-dragging";
/** Puts the drop line on a row. Its value is `before` or `after`. */
const DROP_ATTR = "data-mtk-order-drop";
/** Marks an explorer whose rows have been handed to the observer. */
const BOUND_ATTR = "data-mtk-order-bound";
/** Names the animations this module owns, so only those are cancelled. */
const FLIP_ID = "mtk-order-settle";

/**
 * How far outside a row's band the pointer may sit and still count as pointing
 * at it.
 *
 * Themes leave a margin between rows, and a pointer in that margin is over
 * nothing at all — asking the document what is under it would come back with
 * the container, and the drop line would blink out every few pixels. Measured
 * against each candidate's band instead, and this is what carries the answer
 * across the gap. Deliberately small: it has to cross a margin, never to reach
 * a row the pointer is nowhere near.
 */
const BAND_SLACK = 6;

/* One duration for the whole batch rather than one per row — rows finishing on
   their own clocks read as several separate movements, and what happened was
   one. It grows with the square root of the distance so a screen-length move is
   brisk rather than violent, without a long move turning into a wait. */
const FLIP_MIN_MS = 180;
const FLIP_MAX_MS = 420;
const FLIP_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

/** The handle's glyph. Verified against Obsidian's icon table. */
const HANDLE_ICON = "grip-vertical";

/**
 * The button that switches reordering on and off, in the explorer's toolbar.
 *
 * It wears Obsidian's own classes for a header button — `clickable-icon` and
 * `nav-action-button` — because those are what the buttons beside it wear, and
 * the whole of the look, hover and active wash comes from there. This class is
 * only for finding it again, to take it back out.
 */
const BUTTON_CLASS = "mtk-order-button";
/** Obsidian's own name for "this toolbar toggle is currently on". */
const ACTIVE_CLASS = "is-active";

/**
 * The button's glyph, drawn rather than borrowed.
 *
 * An up arrow over a down arrow with a rule between them: what the button does
 * is let things move up and down past each other. Lucide's `arrow-up-down` is
 * the same idea laid out sideways, and at the ~16px a toolbar affords the two
 * do not read alike. `addIcon` draws into a 100-unit box — Obsidian renders
 * registered icons inside `viewBox="0 0 100 100"`, while `.svg-icon` sets
 * stroke widths for a 24-unit one — so every stroke states its own width, or it
 * comes out hairline-thin.
 */
const ORDER_ICON = "mtk-order-sort";

function registerOrderIcon(): void {
  const stroke = 'stroke-width="8" stroke-linejoin="round"';
  const path = (d: string): string =>
    `<path d="${d}" fill="none" stroke="currentColor" stroke-linecap="round" ${stroke}/>`;

  addIcon(
    ORDER_ICON,
    path("M50 40 V14") +
      path("M37 27 L50 14 L63 27") +
      path("M24 50 H76") +
      path("M50 60 V86") +
      path("M37 73 L50 86 L63 73")
  );
}

interface Landing {
  row: HTMLElement;
  position: "before" | "after";
}

interface DragState {
  /** The row being carried — the `.nav-folder` wrapper. */
  source: HTMLElement;
  handle: HTMLElement;
  /** The element the row shares with its siblings — see `rowContainer`. */
  container: HTMLElement;
  folderPath: string;
  /** The other subfolders sharing this parent, worked out once per gesture. */
  siblings: HTMLElement[];
  landing: Landing | null;
  /** Whether the pointer has travelled since the press, so a plain click on a
   * handle is not mistaken for a drag that failed to land. */
  moved: boolean;
  pointerId: number;
  win: Window;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class FileOrder {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;
  private readonly store: OrderStore;
  /**
   * The explorer builds and discards rows as you scroll, so a row can turn up
   * at any moment and has to arrive already carrying its handle.
   */
  private readonly observer = new MutationObserver(() => this.decorate());
  /**
   * Every row that has been given a handle.
   *
   * Kept because querying the document on the way out is not enough: the
   * explorer recycles rows as you scroll, and a row scrolled out of view is
   * gone from the document while its element lives on in the explorer's own
   * cache. Cleaning up by selector would miss exactly those, and they would
   * scroll back in still carrying a handle after the feature was switched off.
   */
  private readonly decorated = new Set<HTMLElement>();
  /** Null until the explorer has been found and its prototype patched. */
  private patch: SortPatch | null = null;
  /**
   * Whether the "this build cannot be patched" notice has already been shown.
   *
   * `attach()` runs on every `layout-change`, which fires whenever a pane is
   * split, resized or dragged — often several times a second while a divider is
   * being moved. A build whose sorter is not where this expects it would
   * otherwise put a toast on screen for each of those.
   */
  private warned = false;
  /**
   * Which silent failures have already been reported.
   *
   * Everything in this file fails silently by construction. A handle that was
   * never grown and a handle grown on nothing look identical on screen; a press
   * that is refused looks exactly like a press that did nothing; and a drop
   * that records nothing looks like a drag that never happened. Nothing the user
   * can see separates those, which is how a round of work gets spent guessing —
   * so each distinct cause says one line in the console and then keeps quiet.
   */
  private readonly reported = new Set<string>();
  private drag: DragState | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.store = new OrderStore(plugin);
  }

  /**
   * Say once why something was refused, and never again.
   *
   * Only for the paths that fail with nothing at all to show for it — a press
   * that is turned away, a handle with no row under it, a tree with none of the
   * rows the decorating pass is looking for. Each distinct reason gets one line
   * in the console so the next "it does nothing" comes with a reading attached
   * rather than costing another round of looking. Keyed by reason, so a refusal
   * that repeats every time the handle is pressed is still one line.
   */
  private diag(reason: string): void {
    if (this.reported.has(reason)) return;
    this.reported.add(reason);
    console.error(`MarkdownEditorPlus: manual order — ${reason}`);
  }

  enable(): void {
    /* Once per load, and before the first button is built. A name that is not
       registered is not an error — `setIcon` draws an empty `<svg>` for it —
       so the button would simply come up blank. */
    registerOrderIcon();

    // Registered so Obsidian drops the listeners on plugin unload, avoiding
    // callbacks against a torn-down workspace.
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.attach()));

    // A rename or a delete has to be followed, because the record holds names:
    // leave them and a renamed entry simply stops matching, silently, and a
    // deleted one lingers. Both report whether anything changed, and
    // data.json is only written when they say so.
    this.plugin.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.store.onRename(file, oldPath)) void this.save();
      })
    );
    this.plugin.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.store.onDelete(file)) void this.save();
      })
    );

    // Pruning asks the vault whether each recorded path still exists, so it has
    // to wait for the layout: before the vault has finished loading, every
    // folder would look deleted.
    this.app.workspace.onLayoutReady(() => {
      this.prune();
      this.attach();
    });

    this.attach();
  }

  /**
   * Re-read the settings. Called after either switch moves, or the reset button
   * is used, so the change reaches the explorer while the settings panel is
   * still open.
   *
   * There is deliberately no separate switched-off branch any more. Turning the
   * setting off takes away the button and the handles, but not the order, so it
   * is a change of mind like any other rather than a teardown — and one path
   * for both directions is one place for them to stay in step.
   */
  sync(): void {
    this.attach();
  }

  /** Called when the plugin is unloaded. */
  unload(): void {
    this.stop();
  }

  /**
   * Everything the feature put in place, taken back out: the observer, any
   * gesture still in flight, the patch on the explorer's prototype, the button,
   * and every handle.
   *
   * Every step is safe to repeat, and all of them are no-ops on a feature that
   * was never on. Nothing else calls this: unlike switching the setting off —
   * which leaves the recorded order in force and so only rebuilds what is on
   * screen — an unload has to leave Obsidian's prototype as it was found.
   */
  private stop(): void {
    this.observer.disconnect();
    /* Before `undecorate()`, because ending a gesture takes the drop marker off
       the tree and needs the roots to still be reachable. */
    this.endDrag();
    this.releasePatch();
    /* Cleared so a later switch-on binds again. Left set, the next `attach()`
       would skip both roots and assume an observer that is no longer there. */
    for (const root of this.roots()) root.removeAttribute(BOUND_ATTR);
    this.removeButtons();
    this.undecorate();
  }

  /**
   * Bring the explorer up to date with the settings: the patch, the button, and
   * the handles.
   *
   * Runs on load, on every layout change, and after either switch moves, so it
   * has to be cheap and has to be a no-op when nothing has changed. Both hold:
   * re-observing a container the observer already watches does nothing, and
   * decorating a row that already has a handle does not touch the DOM.
   */
  private attach(): void {
    this.ensurePatched();
    /* The button is offered only where it would do something. On a build whose
       sorter could not be reached, `ensurePatched` has just said so in a notice,
       and a button beside it that does nothing would be the worse half of that
       message — and would be the one way to get handles onto a tree with
       nothing to apply them. */
    this.syncButtons(this.patch !== null);

    /* No patch, no handles — they exist to record an order that something will
       apply later, so on a build whose sorter this could not reach they would be
       handles that do nothing. The mode being off comes to the same thing, and
       in either case the handles already on screen have to come off, because
       `syncButtons` has just taken away the button that put them there. */
    if (!this.patch || !this.reordering()) {
      this.observer.disconnect();
      /* Before `undecorate()`, because ending a gesture takes the drop marker
         off the tree and needs the roots to still be reachable. */
      this.endDrag();
      /* Cleared so a later switch-on binds again. Left set, the next `attach()`
         would skip both roots and assume an observer that is no longer there. */
      for (const root of this.roots()) root.removeAttribute(BOUND_ATTR);
      this.undecorate();
      return;
    }

    for (const root of this.roots()) {
      if (root.hasAttribute(BOUND_ATTR)) continue;
      root.setAttribute(BOUND_ATTR, "");
      /* childList only. Decorating a row sets classes and attributes, and
         watching those as well would make every pass schedule another one. */
      this.observer.observe(root, { childList: true, subtree: true });
    }
    this.decorate();
  }

  /* ── The button ─────────────────────────────────────────────────────── */

  /**
   * Whether rows are draggable right now: the button is on screen *and* it has
   * been pressed.
   *
   * Two switches rather than one, because they answer different questions. The
   * setting is the owner's decision about the toolbar — whether this plugin
   * puts a control there at all. The mode is the reader's decision, taken with
   * that control, about whether to be rearranging at this moment. Neither
   * implies the other: the button can be showing and unpressed, which is the
   * state a vault sits in almost all the time.
   */
  private reordering(): boolean {
    return this.plugin.settings.orderButton && this.plugin.settings.orderMode;
  }

  /**
   * Whether anything still needs the patch.
   *
   * The patch is what applies a recorded order, so it has to stay while any is
   * recorded — including after the button has been switched off, which is the
   * whole point of the setting: hiding the button takes away the ability to
   * change the order, not the order. It is also what *makes* an order, so a
   * button that is showing counts even on a vault where nothing is recorded
   * yet, or the first drag would have no sorter to hand its result to.
   *
   * Note the switch, not the mode. The mode cannot be on without the button
   * (`reordering` says so), so asking about the button is asking the wider
   * question, and asking about the mode instead would leave a vault with the
   * button showing and the mode off — which is where every vault starts —
   * without a patch, and therefore with no button either, since a button that
   * could not do anything is not offered.
   *
   * The one state that does not count is the one most vaults are in — no button
   * and nothing recorded — and leaving Obsidian's prototype untouched there is
   * what keeps this feature from existing at all for anyone not using it.
   */
  private needsSorting(): boolean {
    return (
      this.plugin.settings.orderButton || Object.keys(this.plugin.settings.orderMap).length > 0
    );
  }

  /** Press the button: reordering if it was off, off if it was on. */
  private setReordering(on: boolean): void {
    if (this.plugin.settings.orderMode === on) return;
    this.plugin.settings.orderMode = on;

    /* `attach()` and not a narrower call: the mode reaches the patch, the
       button's own wash and every handle, and one path that covers all three
       is one place for them to stay in step. The save follows rather than
       leads, so the press reads as instant. */
    this.attach();
    void this.plugin.saveSettings();
  }

  /**
   * Put a button in every explorer's toolbar, or take them all away, and keep
   * the ones that stay showing the current mode.
   *
   * `usable` is whether the patch is in place; without it the button is
   * withdrawn whatever the setting says, because a press could not lead
   * anywhere. It is passed in rather than read off `this.patch` here so the one
   * caller that can answer it answers it once.
   *
   * Runs from `attach()`, so it runs on every layout change — and the same
   * toolbar can be reached twice in a pass, because split panes put more than
   * one explorer leaf over one sidebar and `roots()` walks leaves. Anything past
   * the first is dropped: a second button would be a duplicate with no way to
   * tell which one is which, and re-touching the first in the common case is a
   * no-op — it is only asked to state what it already states.
   */
  private syncButtons(usable: boolean): void {
    const wanted = usable && this.plugin.settings.orderButton;

    for (const root of this.roots()) {
      const bar = explorerNavBar(root);
      if (!bar) continue;

      const found = Array.from(bar.querySelectorAll<HTMLElement>(`.${BUTTON_CLASS}`));
      if (!wanted) {
        for (const button of found) button.remove();
        continue;
      }
      for (const extra of found.slice(1)) extra.remove();

      const button = found[0] ?? this.makeButton(bar);
      button.classList.toggle(ACTIVE_CLASS, this.plugin.settings.orderMode);
      applyTooltip(button, t(this.modeKey()));
    }
  }

  /**
   * The tooltip for the current mode, named after what pressing the button does
   * rather than the state it is in — the state is already visible, in the wash
   * on the button and in whether the tree has handles.
   */
  private modeKey(): "settings.order.button.start" | "settings.order.button.stop" {
    return this.plugin.settings.orderMode
      ? "settings.order.button.stop"
      : "settings.order.button.start";
  }

  /**
   * The toolbar button.
   *
   * It wears Obsidian's own header-button classes rather than any of this
   * plugin's, so the look, the hover wash and the `is-active` state all come
   * from the app's stylesheet — the same ones the five buttons beside it are
   * under. `BUTTON_CLASS` is only what finds it again to take it back out.
   *
   * Appended rather than prepended: the native buttons are all about this
   * vault, and this one is a mode on top of them, so it belongs at the end.
   */
  private makeButton(bar: HTMLElement): HTMLElement {
    const button = h("div", {
      cls: `clickable-icon nav-action-button ${BUTTON_CLASS}`,
      attr: { role: "button", tabindex: "0" },
    });
    setIcon(button, ORDER_ICON);
    applyTooltip(button, t(this.modeKey()));

    button.addEventListener("click", () => this.setReordering(!this.plugin.settings.orderMode));
    /* A `div` with `role="button"` is not a button to the keyboard, so Enter
       and Space have to be forwarded by hand — and the toolbar is reachable by
       tab, so they will be tried. */
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.setReordering(!this.plugin.settings.orderMode);
    });

    bar.appendChild(button);
    return button;
  }

  /** Take every toolbar button out, on unload. */
  private removeButtons(): void {
    for (const root of this.roots()) {
      for (const button of Array.from(root.querySelectorAll<HTMLElement>(`.${BUTTON_CLASS}`))) {
        button.remove();
      }
    }
  }

  /* ── The patch ──────────────────────────────────────────────────────── */

  /**
   * The patch lands on the view's *prototype*, so finding one explorer is
   * enough to cover every leaf, including ones opened later. But there has to
   * be one to reach the prototype through: the file explorer is usually up
   * before the plugin loads, and when it is not — a workspace that starts with
   * the sidebar closed — `attach()` runs again on the next layout change.
   *
   * It stays for as long as there is anything for it to apply, which is why it
   * outlives the setting: hiding the button takes away the ability to change
   * the order, not the order. It is released on unload, and on the walk back
   * from "has recorded orders" to "has none" — see `needsSorting`.
   */
  private ensurePatched(): void {
    /* Nothing recorded and no button to drag with: leave Obsidian's sorter
       exactly as it was found. Most vaults never touch this feature, and this
       is what keeps them from carrying a patch on the explorer's prototype —
       and from being told about a build that cannot be patched, which is a
       thing only someone using the feature needs to hear. */
    if (!this.needsSorting()) {
      this.releasePatch();
      return;
    }

    if (this.patch) return;

    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) return;

    this.patch = patchSorting(leaf.view, (folder, sorted) => this.store.apply(folder, sorted));

    if (this.patch) {
      this.warned = false;
      /* Rows already on screen were laid out before the patch existed. */
      this.sortAll();
    } else if (!this.warned) {
      /* Without the patch a drag would record an order nothing ever applies,
         and an order already recorded would never be drawn. Say so rather than
         offering a button that cannot do anything — once, because this runs
         again on every layout change. */
      this.warned = true;
      new Notice(t("settings.order.unavailable"));
    }
  }

  private releasePatch(): void {
    if (!this.patch) return;
    this.patch.unpatch();
    this.patch = null;
    this.sortAll();
  }

  /** Ask every explorer leaf to lay its rows out again. */
  private sortAll(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      sortView(leaf.view);
    }
  }

  private roots(): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const root = explorerRootEl(leaf);
      if (root) found.push(root);
    }
    return found;
  }

  private prune(): void {
    const changed = this.store.prune((path) =>
      path === ROOT_KEY ? this.app.vault.getRoot() : this.folderAt(path)
    );
    if (changed) void this.save();
  }

  /**
   * The folder at `path`, or null if there is no folder there.
   *
   * `getAbstractFileByPath` rather than `getFolderByPath`: the latter only
   * arrived in Obsidian 1.5.7 and `manifest.minAppVersion` is 1.4.16, so on the
   * versions this plugin claims to support the shorter call is simply not
   * there. The `instanceof` it folds into its own name is wanted here anyway —
   * this is the one place that has to tell a folder from a file.
   */
  private folderAt(path: string): TFolder | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
  }

  /**
   * Persist without redrawing. The plugin's own `saveSettings()` is for settings
   * that change what is on screen; all that moved here is a name inside an
   * order, and the screen was already sorted by the time this runs.
   */
  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  /* ── The handles ────────────────────────────────────────────────────── */

  private decorate(): void {
    if (!this.reordering()) return;

    let found = 0;
    for (const root of this.roots()) {
      const rows = root.querySelectorAll<HTMLElement>(EXPLORER_FOLDER_SELECTOR);
      found += rows.length;
      for (const row of Array.from(rows)) {
        /* The vault-root row is a `.nav-folder` like any other and matches the
           selector, but it has no parent to be ordered within — it is the vault,
           not something inside it. */
        if (isExplorerRoot(row)) continue;

        const title = itemTitle(row);
        this.decorated.add(row);
        if (title.querySelector(`.${HANDLE_CLASS}`)) continue;

        const handle = this.makeHandle(row);
        /* Prepend so it sits at the left of the title row, where the collapse
           arrow of a folder already is. */
        title.insertBefore(handle, title.firstChild);
      }
    }

    /* The mode is on, the app has explorer leaves, and not one folder row came
       back: the selector and the tree have stopped agreeing, which is the one
       way this feature can be on and show nothing. */
    if (found === 0 && this.roots().length > 0) {
      this.diag(`the tree matched no folder rows (${EXPLORER_FOLDER_SELECTOR})`);
    }
  }

  private makeHandle(row: HTMLElement): HTMLElement {
    const handle = h("span", {
      cls: HANDLE_CLASS,
      attr: { draggable: "false", "data-mtk-order-row": "" },
    });
    setIcon(handle, HANDLE_ICON);
    applyTooltip(handle, t("settings.order.handleHint"));

    handle.addEventListener("pointerdown", (event) => this.beginDrag(row, handle, event));
    /* The handle sits inside a row Obsidian makes draggable, and letting the
       browser start its own drag would hand the row to Obsidian as a file to be
       moved. Measured with a real mouse in a real engine, against the same
       markup, this listener is the *second* line of defence: with `pointerdown`
       prevented the browser never starts a drag at all (0 `dragstart`), and with
       it not prevented this one alone does not save the gesture — the browser
       cancels the pointer instead (1 `dragstart`, then `pointercancel` and no
       `pointerup`). It is kept because it is free and states the intent. */
    handle.addEventListener("dragstart", (event) => event.preventDefault());
    return handle;
  }

  private undecorate(): void {
    /* The remembered rows first — they are the only way to reach one that is
       currently scrolled out of the document. */
    for (const row of this.decorated) {
      row.querySelector(`.${HANDLE_CLASS}`)?.remove();
    }
    this.decorated.clear();
  }

  /* ── The drag ───────────────────────────────────────────────────────── */

  private beginDrag(row: HTMLElement, handle: HTMLElement, event: PointerEvent): void {
    if (!this.reordering() || this.drag) return;
    if (event.button !== 0) return;

    const path = itemPath(row);
    /* The container is the row's parent — *not* `.nav-folder-children`, which
       only rows nested inside a folder have. Asking for that class answered
       null for every top-level folder, so every drag of one was refused here,
       silently: a refused gesture and a handle that does nothing look exactly
       alike. See `rowContainer` for the measured tree. */
    const container = rowContainer(row);
    if (!path || !container) {
      this.diag("a handle was pressed on a row with no path, or no container to sit among");
      return;
    }
    /* Only rows this module decorated carry a handle, and it only decorates
       folders — but a handle can outlive the folder it was grown on, and a drag
       recorded against a note would be a record nothing ever applies. */
    if (!this.isFolderPath(path)) {
      this.diag(`"${path}" is not a folder any more, so there is no place to record it`);
      return;
    }

    /* What actually keeps Obsidian's own drag out of this: measured, one
       `preventDefault()` here is the difference between the browser starting a
       drag of the row (1 `dragstart`, gesture then cancelled) and not starting
       one at all (0 `dragstart`, gesture runs to a `pointerup`). It also
       suppresses the click the browser would otherwise synthesise, which is
       wanted: pressing the handle must not select or expand the folder. */
    event.preventDefault();
    event.stopPropagation();

    const folderPath = parentKey(path);

    /* Nothing to be ordered against. Starting a gesture here would lift a row,
       draw no drop line anywhere, and put it back — the same nothing, by a
       longer route. */
    const siblings = this.findSiblings(container, row, folderPath);
    if (siblings.length === 0) {
      this.diag(`"${path}" is the only folder beside itself, so there is nothing to reorder`);
      return;
    }

    this.drag = {
      source: row,
      handle,
      container,
      folderPath,
      siblings,
      landing: null,
      moved: false,
      pointerId: event.pointerId,
      win: container.ownerDocument.defaultView ?? window,
    };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is what keeps the gesture alive when the pointer leaves the
         window; without it the listeners below still cover the common case. */
    }

    row.classList.add(DRAGGING_CLASS);

    /* Capture phase throughout: Obsidian listens for these further out, and
       capture runs outermost-first, so anything bound to the row itself could
       be cut off before it is ever reached. */
    const options = { capture: true };
    this.drag.win.addEventListener("pointermove", this.onMove, options);
    this.drag.win.addEventListener("pointerup", this.onUp, options);
    this.drag.win.addEventListener("pointercancel", this.onCancel, options);
  }

  /**
   * The sibling folders the row could be dropped among, minus the one being
   * dragged.
   *
   * Worked out once per gesture rather than on every move: the tree's shape is
   * not changing under it, because nothing here moves a node mid-gesture.
   *
   * Folders of the same parent only. A drop means "put this folder between
   * those two", and both halves of that are answers about one run of slots:
   * Obsidian draws every folder above every file, so offering a note as a
   * landing spot would draw a line at a place the folder can never occupy.
   *
   * The `parentKey` test is what draws that line, not the container: a
   * top-level row's container is the whole scroll layer, so its subtree also
   * holds the rows of every expanded folder below it. Matching on the path is
   * both narrower and steadier than matching on where a row happens to sit.
   */
  private findSiblings(
    container: HTMLElement,
    source: HTMLElement,
    folderPath: string
  ): HTMLElement[] {
    const rows = container.querySelectorAll<HTMLElement>(EXPLORER_FOLDER_SELECTOR);
    return Array.from(rows).filter((row) => {
      if (row === source) return false;
      const path = itemPath(row);
      return Boolean(path) && parentKey(path) === folderPath;
    });
  }

  /** Whether a vault path names a folder. */
  private isFolderPath(path: string): boolean {
    return this.folderAt(path) !== null;
  }

  private readonly onMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.moved = true;
    this.mark(this.locate(drag, event.clientX, event.clientY));
  };

  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const { landing, moved, folderPath } = drag;
    const moving = nameOf(itemPath(drag.source));
    const target = landing ? nameOf(itemPath(landing.row)) : "";
    const position = landing?.position ?? "before";

    this.endDrag();

    if (!landing) {
      /* A press with no travel is a click on the handle, not a failed drag, and
         has nothing to report. One that travelled and landed nowhere means the
         pointer left the rows before the release. */
      if (moved) this.diag("the pointer was released while it was over no row at all");
      return;
    }
    if (!moving || !target || moving === target) return;
    void this.commit(folderPath, moving, target, position);
  };

  private readonly onCancel = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.endDrag();
  };

  /**
   * Where the row would land, or null to draw nothing.
   *
   * This asks "which row is the pointer on" rather than "which gap is nearest",
   * and it reads geometry rather than asking the document what is under the
   * pointer. Both are the same decision made twice: the pointer is often over
   * no row at all — themes leave a margin between rows — and `elementFromPoint`
   * answers "nothing" there, which blinks the drop line out. Measuring against
   * each candidate's band answers everywhere, and `BAND_SLACK` is what carries
   * the answer across the margin without letting it reach a neighbour.
   */
  private locate(drag: DragState, x: number, y: number): Landing | null {
    const bounds = drag.container.getBoundingClientRect();
    /* The pointer can be anywhere in the window; outside the tree there is
       nothing to point at. */
    if (x < bounds.left || x > bounds.right) return null;
    if (y < bounds.top || y > bounds.bottom) return null;

    let best: HTMLElement | null = null;
    let bestMiddle = 0;
    let least = Infinity;

    for (const row of drag.siblings) {
      const item = row.closest<HTMLElement>(".tree-item") ?? row;

      /* Only the strip of the wrapper that stands for the row itself, which is
         everything above its children. An expanded folder's wrapper reaches all
         the way down past its subtree, and measuring against that would hand
         the pointer to a title row it is nowhere near. */
      const box = item.getBoundingClientRect();
      const kids = item.querySelector<HTMLElement>(":scope > .nav-folder-children");
      const bottom = kids ? kids.getBoundingClientRect().top : box.bottom;
      if (box.height === 0 && bottom === 0) continue;

      const distance = y < box.top ? box.top - y : y > bottom ? y - bottom : 0;
      if (distance > BAND_SLACK || distance >= least) continue;

      best = row;
      bestMiddle = (box.top + bottom) / 2;
      least = distance;
    }

    if (!best) return null;
    return { row: best, position: y < bestMiddle ? "before" : "after" };
  }

  private mark(landing: Landing | null): void {
    const drag = this.drag;
    if (!drag) return;
    if (
      drag.landing &&
      drag.landing.row === landing?.row &&
      drag.landing.position === landing.position
    ) {
      return;
    }

    this.unmark();
    drag.landing = landing;
    if (!landing) return;

    /* On the title, not on the wrapper. A folder's `.tree-item` wraps its whole
       subtree, so a line drawn on it lands at the far end of that subtree: on a
       folder with three children it measured 116px below the pointer, and a
       drop line that far from the pointer is indistinguishable from a drag that
       is doing nothing at all. The title is the strip the pointer is measured
       against, so anchoring there puts the line within a few pixels of it. */
    itemTitle(landing.row).setAttribute(DROP_ATTR, landing.position);
  }

  private unmark(): void {
    for (const root of this.roots()) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${DROP_ATTR}]`))) {
        el.removeAttribute(DROP_ATTR);
      }
    }
  }

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;

    this.unmark();
    drag.source.classList.remove(DRAGGING_CLASS);
    drag.win.removeEventListener("pointermove", this.onMove, { capture: true });
    drag.win.removeEventListener("pointerup", this.onUp, { capture: true });
    drag.win.removeEventListener("pointercancel", this.onCancel, { capture: true });
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }

    this.drag = null;
  }

  private async commit(
    folderPath: string,
    moving: string,
    target: string,
    position: "before" | "after"
  ): Promise<void> {
    /* Freeze what is on screen right now, before every drag rather than only
       the first. The move below is expressed as "put this name next to that
       one", so both names have to be in the record for it to mean anything —
       and a subfolder added since the last drag is not, until this runs. */
    this.store.capture(folderPath, this.displayedNames(folderPath));

    this.store.move(folderPath, moving, target, position);
    await this.save();

    /* Slide the rows rather than swapping them out from under the pointer — a
       list that simply looks different afterwards leaves you unsure the drop
       did what you meant. */
    this.animateRows(() => this.sortAll());
    this.decorate();
  }

  /**
   * One folder's subfolders, in the order it is drawn: Obsidian's own sorting
   * with this plugin's record already laid over it.
   *
   * Asked of the unpatched sorter rather than read off the screen — see the
   * header of `explorer-sort.ts` for why the DOM cannot answer this.
   */
  private displayedNames(folderPath: string): string[] {
    if (!this.patch) return [];

    const folder = folderPath === ROOT_KEY ? this.app.vault.getRoot() : this.folderAt(folderPath);
    if (!folder) return [];

    return this.store
      .apply(folder, this.patch.nativeItems(folder))
      .filter((item) => item.file instanceof TFolder)
      .map((item) => item.file.name);
  }

  /* ── The settle ─────────────────────────────────────────────────────── */

  /**
   * Slide rows to their new places instead of teleporting them.
   *
   * The rows are measured, rearranged, and immediately drawn back where they
   * were, all in one tick so nothing is painted in between; the animation that
   * follows is what the eye actually sees. The explorer reuses its row elements
   * when it re-sorts, which is what makes the before-and-after measurements
   * refer to the same objects.
   *
   * What moves is the `.tree-item` wrappers, not the title rows inside them.
   * The wrapper is what holds a layout slot: animating the titles leaves the
   * wrappers already at their destinations, and the tree is drawn torn in half
   * for the length of the animation.
   *
   * Web Animations rather than a transition written onto the element, because
   * it needs no stylesheet to be in step with the build and leaves no inline
   * style behind to clean up. It also composes with whatever a theme does to
   * `transform` instead of racing it.
   */
  private animateRows(apply: () => void): void {
    const items: HTMLElement[] = [];
    for (const root of this.roots()) {
      items.push(...Array.from(root.querySelectorAll<HTMLElement>(".nav-files-container .tree-item")));
    }

    /* End any settle still in flight before measuring, or the "before"
       positions are the offsets of the last one rather than where the rows
       actually sit. */
    for (const item of items) this.settle(item);

    const before = new Map<HTMLElement, number>();
    for (const item of items) before.set(item, item.getBoundingClientRect().top);

    apply();

    /* Reading positions again forces layout, and the offsets go on before the
       browser has painted, so a row is never seen at its destination first. */
    if (prefersReducedMotion()) return;

    const moved: [HTMLElement, number][] = [];
    let furthest = 0;
    for (const [item, top] of before) {
      if (!item.isConnected) continue;
      const delta = top - item.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      moved.push([item, delta]);
      furthest = Math.max(furthest, Math.abs(delta));
    }
    if (moved.length === 0) return;

    const ms = Math.min(FLIP_MAX_MS, Math.round(FLIP_MIN_MS + Math.sqrt(furthest) * 12));
    for (const [item, delta] of moved) {
      item.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: ms,
        easing: FLIP_EASE,
        id: FLIP_ID,
      });
    }
  }

  private settle(item: HTMLElement): void {
    /* Only the animations this module started. A theme is entitled to its own
       transitions, and cancelling those would be a bug in someone else's CSS. */
    for (const animation of item.getAnimations()) {
      if (animation.id === FLIP_ID) animation.cancel();
    }
  }
}
