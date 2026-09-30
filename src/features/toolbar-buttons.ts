import { MarkdownView, Menu, Notice, setIcon } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import {
  isGroupLabel,
  isSubmenu,
  colorPanelFor,
  type ColorPanel,
  type ToolbarCommand,
} from "../core/toolbar-commands";
import { t } from "../i18n";
import { runCommand, toolbarLabel } from "../utils/commands";
import { closeColorPicker } from "../ui/color-picker";
import { openFontColorPicker } from "./font-color";
import { openBackgroundColorPicker } from "./background-color";
import { BRUSH_COMMAND_ID } from "./format-brush";

/**
 * Builds the command buttons for a toolbar.
 *
 * This is the single source of truth for what a toolbar button looks like and
 * how it behaves — the pinned editor toolbar and the floating selection toolbar
 * both call it, so the two can never drift apart: a command added in settings
 * shows up in both, and a submenu or colour button behaves identically in each.
 *
 * The three kinds of press (run, open submenu, open colour panel) are the same
 * three the pinned bar already has; they are kept here rather than duplicated
 * across the two callers.
 */
export function appendToolbarButtons(container: HTMLElement, plugin: MarkdownEditorPlusPlugin): void {
  const commands = plugin.settings.toolbarCommands;
  for (const cmd of commands) {
    // A submenu is recognised by having no command to run, not by having
    // children: one that is still empty is a submenu too, and treating it as
    // a command would run the empty string and report "command not found".
    const menu = isSubmenu(cmd);
    // The colour entries are the third kind: they *have* a command, and the
    // command opens the same panel, but the press has to anchor the panel to
    // the button rather than to the caret.
    const panel = colorPanelFor(cmd);

    const btn = document.createElement("button");
    btn.className = "clickable-icon mtk-toolbar-btn";
    // A stable hook for the brush's armed style, which the body class drives.
    if (cmd.commandId === BRUSH_COMMAND_ID) btn.classList.add("is-brush");
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-label", toolbarLabel(plugin.app, cmd));
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
      btn.addEventListener("click", () => openSubmenu(plugin, cmd, btn));
    } else if (panel) {
      btn.addEventListener("click", () => openColorPicker(plugin, panel, btn));
    } else {
      btn.addEventListener("click", () => execute(plugin, cmd));
    }
    container.appendChild(btn);
  }
}

/** Closes the shared colour panel, wherever it was last opened from. */
export function closeToolbarColorPicker(): void {
  closeColorPicker();
}

/** Opens the swatch panel under the button that asked for it. */
function openColorPicker(
  plugin: MarkdownEditorPlusPlugin,
  panel: ColorPanel,
  anchor: HTMLElement
): void {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const editor = view?.editor ?? null;
  if (panel === "background") {
    openBackgroundColorPicker(editor, anchor);
    return;
  }
  openFontColorPicker(editor, anchor);
}

function openSubmenu(
  plugin: MarkdownEditorPlusPlugin,
  parent: ToolbarCommand,
  anchor: HTMLElement
): void {
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
      // hand-drawn section title.
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(child.label);
        item.setIsLabel(true);
      });
      continue;
    }
    menu.addItem((item) => {
      item.setTitle(toolbarLabel(plugin.app, child));
      if (child.icon) item.setIcon(child.icon);
      item.onClick(() => execute(plugin, child));
    });
  }

  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
}

function execute(plugin: MarkdownEditorPlusPlugin, cmd: ToolbarCommand): void {
  if (runCommand(plugin.app, cmd.commandId)) {
    // The brush arms from whatever the toolbar last ran; the whitelist
    // lives inside the brush, so this stays a one-line hand-off.
    plugin.formatBrush?.record(cmd.commandId);
    return;
  }
  new Notice(t("notice.commandNotFound", { id: cmd.commandId }));
}
