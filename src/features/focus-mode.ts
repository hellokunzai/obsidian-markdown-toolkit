/**
 * Fullscreen focus mode, as it is actually turned on and off.
 *
 * Where the note lives and what counts as an overlay are decided in
 * `core/focus-mode`; this is the part that talks to the browser: the fullscreen
 * request, the change event that ends it, and the watcher that keeps new
 * overlays in sight.
 *
 * Three things about that are worth knowing before reading it.
 *
 * The browser is the source of truth for whether the mode is on. `ESC` exits
 * fullscreen without asking anyone, the fullscreen element can be removed with
 * the layout, and another window can take the screen — all three look identical
 * from here, and all three arrive as one `fullscreenchange`. So there is no
 * "active" flag: the mode is on exactly while `fullscreenElement` is our host,
 * and the event is the only place that decides.
 *
 * The request has to go out untouched. A fullscreen request is only honoured
 * while the click that started it is still live, so nothing may happen between
 * the press and `requestFullscreen()` — no `await`, and no lookup that could
 * yield.
 *
 * The overlays are carried, not cloned, and they go back where they came from.
 * A menu that Obsidian dismissed while the mode was on has already been removed
 * from the document by the time the mode ends, and is simply dropped.
 */
import { Notice } from "obsidian";
import { collectOverlays, findFocusTarget, isRelocatableOverlay } from "../core/focus-mode";
import { t } from "../i18n";

/**
 * The document of the window the user is working in.
 *
 * Not always `document`: in a popout window it is that window's own, and making
 * the main window fullscreen while the user is looking at the popout would take
 * the wrong half of the app. `activeDocument` is an Obsidian global rather than
 * an import, hence the guard — and the same guard is what lets a plain web page
 * (as in the smoke test) run this class unchanged.
 */
function focusedDocument(): Document {
  return typeof activeDocument === "undefined" ? document : activeDocument;
}

export class FocusMode {
  /** The element the screen belongs to, for as long as it does. */
  private host: Element | null = null;
  /** Overlays carried in, in arrival order, so they can go back. */
  private carried: Element[] = [];
  private observer: MutationObserver | null = null;

  /**
   * Turns the mode on, or off when it is already on.
   *
   * A second press is answered by asking the document to leave fullscreen
   * rather than by undoing anything here: the change event that follows does the
   * work, which keeps `ESC` and a second press on exactly the same path.
   */
  toggle(): void {
    const doc = focusedDocument();
    // Whatever holds the screen goes back — usually our own element, on the
    // second press.
    if (doc.fullscreenElement) {
      void doc.exitFullscreen();
      return;
    }
    this.enter(doc);
  }

  /**
   * Takes the mode down with the plugin.
   *
   * A disabled plugin must not leave the screen belonging to an element only it
   * knows how to hand back. The listener and the watcher are not registered
   * through `registerEvent`, so nothing else would clear them, and the overlays
   * would stay where they were carried.
   */
  unload(): void {
    const host = this.host;
    if (!host) return;
    const doc = host.ownerDocument;
    if (doc.fullscreenElement === host) void doc.exitFullscreen();
    // The change event cannot be waited for: its listener is being removed
    // right here, so this call is the last chance the overlays get to go home.
    this.leave(doc);
  }

  private enter(doc: Document): void {
    const host = findFocusTarget(doc);
    if (!host || typeof host.requestFullscreen !== "function") {
      new Notice(t("notice.focusUnavailable"));
      return;
    }

    this.host = host;
    // Registered before the request, and on the document this element belongs
    // to, so the listener and the element cannot end up in different windows.
    doc.addEventListener("fullscreenchange", this.onFullscreenChange);

    // Straight out of the gesture that started this. Anything awaited first
    // would spend the activation the browser needs and the request would be
    // refused.
    void host.requestFullscreen().catch((error: unknown) => {
      console.error("MarkdownEditorPlus: could not enter fullscreen focus mode.", error);
      this.leave(doc);
    });
  }

  /**
   * The one place that decides the mode is over.
   *
   * `currentTarget` rather than a captured document: this handler is bound once
   * per session and the session's document is whichever one it was registered
   * on.
   */
  private readonly onFullscreenChange = (event: Event): void => {
    const target = event.currentTarget;
    // A shape check rather than `instanceof Document`: in a popout window the
    // event comes from that window's document, and an `instanceof` across two
    // windows is quietly false.
    if (!target || !("fullscreenElement" in target)) return;
    const doc = target as Document;
    // The screen went to our host: adopt what is on it.
    if (doc.fullscreenElement === this.host && this.host) {
      this.carryInto(doc);
      return;
    }
    // Everything else — back to normal, or handed to some other element — means
    // this mode is over.
    this.leave(doc);
  };

  private carryInto(doc: Document): void {
    const host = this.host;
    if (!host) return;

    // What was already open: a menu left on screen, the tooltip Obsidian keeps
    // around for the next hover, a dialog. Those were appended by Obsidian
    // before there was anything to watch.
    for (const overlay of collectOverlays(doc.body)) this.carry(overlay);

    // Started after the sweep, and only ever reading what gets added: moving an
    // overlay out is itself a removal from the body this observes.
    this.observer = new MutationObserver((records) => {
      if (!this.host) return;
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (isRelocatableOverlay(node)) this.carry(node as Element);
        }
      }
    });
    this.observer.observe(doc.body, { childList: true });
  }

  private carry(overlay: Element): void {
    const host = this.host;
    if (!host || overlay === host || host.contains(overlay)) return;
    this.carried.push(overlay);
    host.appendChild(overlay);
  }

  private leave(doc: Document): void {
    // Disconnected first: putting the overlays back appends them to the very
    // body being watched, and a live watcher would carry them straight in again.
    this.observer?.disconnect();
    this.observer = null;
    doc.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.host = null;

    // Only the ones still on screen go back. A menu dismissed during the mode
    // has already been removed from the document by the code that owned it.
    for (const overlay of this.carried) {
      if (overlay.isConnected) doc.body.appendChild(overlay);
    }
    this.carried = [];
  }
}
