import { MarkdownView, Menu, Notice, setIcon, type App } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { isGroupLabel, isSubmenu, colorPanelFor, type ColorPanel, type ToolbarCommand } from "../core/toolbar-commands";
import { t } from "../i18n";
import { runCommand, toolbarLabel } from "../utils/commands";
import { closeColorPicker } from "../ui/color-picker";
import { openFontColorPicker } from "./font-color";
import { openBackgroundColorPicker } from "./background-color";
import { BRUSH_COMMAND_ID } from "./format-brush";

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
    const commands = this.plugin.settings.toolbarCommands;
    if (commands.length === 0) {
      bar.classList.add("is-empty");
      return;
    }
    bar.classList.remove("is-empty");

    for (const cmd of commands) {
      // A submenu is recognised by having no command to run, not by having
      // children: one that is still empty is a submenu too, and treating it as
      // a command would run the empty string and report "command not found".
      const menu = isSubmenu(cmd);
      // The colour entries are the third kind: they *have* a command, and the
      // command opens the same panel, but the toolbar's press has to anchor the
      // panel to the button rather than to the caret.
      const panel = colorPanelFor(cmd);

      const btn = document.createElement("button");
      btn.className = "clickable-icon mtk-toolbar-btn";
      // A stable hook for the brush's armed style, which the body class drives.
      if (cmd.commandId === BRUSH_COMMAND_ID) btn.classList.add("is-brush");
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-label", toolbarLabel(this.app, cmd));
      setIcon(btn, cmd.icon || (menu ? "menu" : "command"));

      if (menu || panel) {
        // A menu and a plain button look identical until pressed, so the caret
        // drawn in the corner is the only thing that tells them apart.
        btn.classList.add("is-menu");
        btn.setAttribute("aria-haspopup", "true");
      }

      // Three kinds of press, and the two that open something are the two that
      // do not run the command behind them.
      if (menu) {
        btn.addEventListener("click", () => this.openSubmenu(cmd, btn));
      } else if (panel) {
        btn.addEventListener("click", () => this.openColorPicker(panel, btn));
      } else {
        btn.addEventListener("click", () => this.execute(cmd));
      }
      bar.appendChild(btn);
    }
  }

  /** Opens the swatch panel under the button that asked for it. */
  private openColorPicker(panel: ColorPanel, anchor: HTMLElement): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor ?? null;
    if (panel === "background") {
      openBackgroundColorPicker(editor, anchor, this.plugin.settings.backgroundColorCustom);
      return;
    }
    openFontColorPicker(editor, anchor, this.plugin.settings.fontColorCustom);
  }

  private openSubmenu(parent: ToolbarCommand, anchor: HTMLElement): void {
    const children = parent.children ?? [];
    // A heading is not something to press, so a menu holding nothing else is
    // still an empty menu — `every` on an empty array is true, which is what
    // keeps the original case covered too.
    if (children.every(isGroupLabel)) {
      new Notice(t("notice.emptySubmenu"));
      return;
    }

    const menu = new Menu();
    for (const child of children) {
      if (isGroupLabel(child)) {
        // Obsidian's own heading row: muted, unclickable, and — paired with the
        // separator above it — the native equivalent of the reference plugin's
        // hand-drawn section title. Drawing our own would mean giving up the
        // theme, the flip-up placement and the keyboard handling with it.
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle(child.label);
          item.setIsLabel(true);
        });
        continue;
      }
      menu.addItem((item) => {
        item.setTitle(toolbarLabel(this.app, child));
        if (child.icon) item.setIcon(child.icon);
        item.onClick(() => this.execute(child));
      });
    }

    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private execute(cmd: ToolbarCommand): void {
    if (runCommand(this.app, cmd.commandId)) {
      // The brush arms from whatever the toolbar last ran; the whitelist
      // lives inside the brush, so this stays a one-line hand-off.
      this.plugin.formatBrush?.record(cmd.commandId);
      return;
    }
    new Notice(t("notice.commandNotFound", { id: cmd.commandId }));
  }

  private remove(): void {
    this.disconnectObserver();
    // The panel is anchored to a button that is about to go away, and it holds
    // `document` listeners of its own: left open it would sit over the editor
    // with nothing left that could dismiss it.
    closeColorPicker();
    document.querySelectorAll(".mtk-editor-toolbar").forEach((el) => el.remove());
  }

  private disconnectObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
