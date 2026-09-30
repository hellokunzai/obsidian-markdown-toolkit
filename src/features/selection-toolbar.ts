import { MarkdownView } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { appendToolbarButtons, closeToolbarColorPicker } from "./toolbar-buttons";

/**
 * Floating selection toolbar.
 *
 * A copy of the pinned editor toolbar's buttons that follows the text selection
 * instead of sitting at the top of the editor. It appears only while there is a
 * non-empty selection inside the active Markdown source editor, positions itself
 * above the selection (flipping below when there is no room), and disappears the
 * moment the selection collapses, the view scrolls, the leaf changes, or the
 * user presses Escape.
 *
 * It is driven by the document's `selectionchange` event, which fires for both
 * desktop drag-selection and mobile long-press selection — so one code path
 * covers the two platforms. The buttons are the same ones the pinned bar draws,
 * built by the shared `appendToolbarButtons`, so the two never diverge.
 */
export class SelectionToolbar {
  private readonly plugin: MarkdownEditorPlusPlugin;

  /** The floating bar, created on first show and kept in the DOM until unload. */
  private bar: HTMLElement | null = null;
  /** Pending show timer for the debounce; cleared whenever the selection moves. */
  private debounceTimer: number | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
  }

  enable(): void {
    document.addEventListener("selectionchange", this.onSelectionChange);
    // Any of these means the selection is no longer where it was, so the bar
    // would be left floating over the wrong place — take it down.
    document.addEventListener("scroll", this.onDismiss, true);
    window.addEventListener("resize", this.onDismiss);
    document.addEventListener("keydown", this.onKeyDown);
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => this.remove())
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.remove())
    );
  }

  /**
   * Re-reads the enable switch: hides the bar if it was just turned off.
   *
   * Called from the settings tab. Command changes while the bar is visible are
   * picked up automatically, because `show` rebuilds the buttons each time.
   */
  refresh(): void {
    if (!this.plugin.settings.selectionToolbarEnabled) {
      this.clearDebounce();
      this.remove();
    }
  }

  unload(): void {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("scroll", this.onDismiss, true);
    window.removeEventListener("resize", this.onDismiss);
    document.removeEventListener("keydown", this.onKeyDown);
    this.clearDebounce();
    this.remove();
  }

  /* ----------------------------------------------------------- selection */

  private onSelectionChange = (): void => {
    if (!this.plugin.settings.selectionToolbarEnabled) {
      this.remove();
      return;
    }

    const found = this.getMarkdownSelection();
    this.clearDebounce();
    if (!found) {
      // Collapsed selection or selection outside the editor: the bar goes away.
      this.remove();
      return;
    }

    // Reset the timer on every change so the bar only appears once the selection
    // has stopped moving — that is what keeps it from flickering mid-drag.
    const delay = this.plugin.settings.selectionToolbarDebounce;
    if (delay <= 0) {
      this.show(found);
    } else {
      this.debounceTimer = window.setTimeout(() => this.show(found), delay);
    }
  };

  /** Returns the current selection if it is a non-empty selection in the source editor. */
  private getMarkdownSelection(): Range | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") return null;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    // Ignore whitespace-only selections and anything outside the editor.
    if (!selection.toString().trim()) return null;
    if (!view.contentEl.contains(range.commonAncestorContainer)) return null;
    return range;
  }

  /* --------------------------------------------------------------- show */

  private show(range: Range): void {
    if (!this.bar) {
      this.bar = document.createElement("div");
      this.bar.className = "mtk-selection-toolbar";
      this.bar.setAttribute("role", "toolbar");
      // Pressing a button must not drop the editor selection underneath it —
      // the commands act on that selection, so we swallow the mousedown that
      // would otherwise blur the editor. The click still fires. On touch, the
      // browser synthesises a mousedown from the tap; preventing its default
      // would cancel the click and the button would never run, so touch is left
      // alone and the tap goes through.
      this.bar.addEventListener("mousedown", (event) => {
        const fromTouch = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
          .sourceCapabilities?.firesTouchEvents === true;
        if (!fromTouch) event.preventDefault();
      });
      document.body.appendChild(this.bar);
    }
    // Rebuild every time so command-list edits in settings show up immediately.
    this.bar.replaceChildren();
    appendToolbarButtons(this.bar, this.plugin);
    this.positionBar(range);
  }

  /** Places the bar above the selection, flipping below when there is no room. */
  private positionBar(range: Range): void {
    const bar = this.bar;
    if (!bar) return;

    const rect = range.getBoundingClientRect();
    // Measure off-screen so the position maths can use the real size.
    bar.style.visibility = "hidden";
    bar.style.left = "0px";
    bar.style.top = "0px";
    const barWidth = bar.offsetWidth;
    const barHeight = bar.offsetHeight;

    const margin = 8;
    let top = rect.top - barHeight - 8;
    let below = false;
    if (top < margin) {
      top = rect.bottom + 8;
      below = true;
    }
    let left = rect.left + rect.width / 2 - barWidth / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - barWidth - margin));

    bar.style.top = `${Math.max(margin, top)}px`;
    bar.style.left = `${left}px`;
    bar.classList.toggle("is-below", below);
    bar.style.visibility = "visible";
  }

  /* -------------------------------------------------------------- hide */

  private onDismiss = (): void => {
    this.clearDebounce();
    this.remove();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.clearDebounce();
      this.remove();
    }
  };

  private remove(): void {
    if (!this.bar) return;
    // The colour panel is anchored to a button that is about to go away.
    closeToolbarColorPicker();
    this.bar.remove();
    this.bar = null;
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
