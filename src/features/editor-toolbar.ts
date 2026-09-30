import { MarkdownView, type App } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { applyToolbarBackground, TOOLBAR_BACKGROUND_DEFAULT } from "../core/toolbar-background";
import { appendToolbarButtons, closeToolbarColorPicker } from "./toolbar-buttons";

/**
 * Editor toolbar.
 *
 * Renders the commands configured in settings as a bar pinned to the top of the
 * active Markdown editor. It is re-pinned whenever the active leaf changes, and
 * removed when the editor is not in source mode. Command execution is delegated
 * to Obsidian's own command registry, so anything in the palette works here —
 * including the plugin's own insert/edit commands.
 *
 * An entry with children opens a menu instead of running anything; the menu is
 * Obsidian's own, so it picks up the theme, the placement heuristics and the
 * keyboard handling for free. The two colour entries are the exception: their
 * commands exist, but the toolbar opens a swatch panel for them, anchored to
 * the button, because neither grid fits in a menu.
 */
export class EditorToolbar {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;
  private observer: MutationObserver | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sync()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.sync()));
    // The initial onload call often runs before the workspace leaves are ready,
    // so wait for layout ready before the first real pin attempt.
    this.app.workspace.onLayoutReady(() => this.sync());
  }

  /**
   * Stops watching and takes the bar down.
   *
   * The observer is not registered through `registerEvent`, so nothing else
   * clears it: left alone it outlives `onunload` and re-pins the toolbar the
   * next time the view re-renders — a plugin that is meant to be off.
   */
  unload(): void {
    this.remove();
  }

  /** Re-applies the toolbar to the current active Markdown editor. */
  sync(): void {
    this.disconnectObserver();

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") {
      this.remove();
      return;
    }

    const contentEl = view.contentEl;
    let bar = contentEl.querySelector(".mtk-editor-toolbar") as HTMLElement | null;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "mtk-editor-toolbar";
      // Place it above the inline title / source view so it is clearly visible.
      contentEl.insertBefore(bar, contentEl.firstChild);
    }
    this.renderBar(bar);

    // Re-pin if Obsidian re-renders the view (mode switch, inline title toggle,
    // or workspace replace). childList is enough: we only care about structural
    // changes that could evict the toolbar.
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(contentEl, { childList: true });
  }

  private renderBar(bar: HTMLElement): void {
    // Avoid Obsidian's prototype extension for portability.
    bar.replaceChildren();
    /* Painted before the empty check below, so a bar that is hidden right now
       still carries the colour the moment a command is added to it. Read
       defensively: `data.json` may predate the field, and the value would then
       be `undefined` — which would be written into the property verbatim. */
    const background = this.plugin.settings.editorToolbarBackground;
    applyToolbarBackground(
      bar,
      typeof background === "string" ? background : TOOLBAR_BACKGROUND_DEFAULT
    );
    const commands = this.plugin.settings.toolbarCommands;
    if (commands.length === 0) {
      bar.classList.add("is-empty");
      return;
    }
    bar.classList.remove("is-empty");

    // The buttons are built by the shared helper the selection toolbar also
    // uses, so the pinned bar and the floating bar can never disagree about
    // what a command looks like or how its press behaves.
    appendToolbarButtons(bar, this.plugin);
  }

  private remove(): void {
    this.disconnectObserver();
    // The panel is anchored to a button that is about to go away, and it holds
    // `document` listeners of its own: left open it would sit over the editor
    // with nothing left that could dismiss it.
    closeToolbarColorPicker();
    document.querySelectorAll(".mtk-editor-toolbar").forEach((el) => el.remove());
  }

  private disconnectObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
