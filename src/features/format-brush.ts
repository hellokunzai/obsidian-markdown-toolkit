/**
 * The format painter (格式刷).
 *
 * Ported from `obsidian-editing-toolbar`'s `toggle-format-brush` — the one
 * feature of its default list with no core command behind it. Arming it
 * remembers which format to paint (the last brushable command the toolbar ran,
 * or a probe of the current selection's markup), and while armed every new
 * selection gets that command applied. A second click or a right-click disarms.
 *
 * State is deliberately not persisted: a brush that survives a reload would
 * surprise more than it helps.
 */
import { MarkdownView, Notice, debounce } from "obsidian";
import type { Editor } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { t } from "../i18n";
import { commandName, runCommand } from "../utils/commands";
import { UNDERLINE_COMMAND_ID } from "./underline";

/** The plugin command the toolbar's brush button points at. */
export const BRUSH_COMMAND_ID = "markdown-toolkit:toggle-format-brush";

/**
 * Body class while the brush is armed. The stylesheet turns it into a cursor
 * change and a highlighted button, so no re-render is needed on toggle.
 */
export const BRUSH_ACTIVE_CLASS = "mtk-format-brush-cursor";

/**
 * Commands that make sense to re-apply onto a selection. Everything the
 * toolbar executes is recorded, but only these are ever armed — so an undo,
 * an insert or a table never comes out of the brush.
 */
const BRUSHABLE = new Set<string>([
  "editor:toggle-bold",
  "editor:toggle-italics",
  "editor:toggle-strikethrough",
  "editor:toggle-highlight",
  "editor:toggle-code",
  "editor:toggle-blockquote",
  "editor:insert-callout",
  "editor:set-heading-1",
  "editor:set-heading-2",
  "editor:set-heading-3",
  "editor:set-heading-4",
  "editor:set-heading-5",
  "editor:set-heading-6",
  "editor:toggle-numbered-list",
  "editor:toggle-bullet-list",
  "editor:toggle-checklist-status",
  "editor:clear-formatting",
  // The plugin's own underline command, the one non-core entry here.
  UNDERLINE_COMMAND_ID,
]);

/** True when a toolbar-run command is worth remembering for the brush. */
export function isBrushableCommand(commandId: string): boolean {
  return BRUSHABLE.has(commandId);
}

/**
 * Format probes for the "arm from the selection" path, ported from the
 * reference's `toggleFormatBrush`. Bold is tested before italic (they share a
 * marker) and headings run longest-first (they share a prefix), so order here
 * is load-bearing.
 */
const DETECTORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\*\*[\s\S]+\*\*$/, "editor:toggle-bold"],
  [/^==[\s\S]+==$/, "editor:toggle-highlight"],
  [/^~~[\s\S]+~~$/, "editor:toggle-strikethrough"],
  [/^`[\s\S]+`$/, "editor:toggle-code"],
  // Underline is the one entry here that is not a core marker: it is the HTML
  // tag this plugin writes, so the probe matches the tag rather than a symbol.
  [/^<u>[\s\S]+<\/u>$/i, UNDERLINE_COMMAND_ID],
  [/^\*[\s\S]+\*$/, "editor:toggle-italics"],
  [/^_[\s\S]+_$/, "editor:toggle-italics"],
  [/^###### /, "editor:set-heading-6"],
  [/^##### /, "editor:set-heading-5"],
  [/^#### /, "editor:set-heading-4"],
  [/^### /, "editor:set-heading-3"],
  [/^## /, "editor:set-heading-2"],
  [/^# /, "editor:set-heading-1"],
];

/** The core command that would produce the given selection, or "" when unknown. */
export function detectFormatFromSelection(text: string): string {
  for (const [pattern, commandId] of DETECTORS) {
    if (pattern.test(text)) return commandId;
  }
  return "";
}

/** Keys that extend a keyboard-driven selection, mirroring the reference's list. */
const SELECTION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ShiftLeft",
  "ShiftRight",
]);

export class FormatBrush {
  private readonly plugin: MarkdownEditorPlusPlugin;
  /** The command applied to the next selection while armed. */
  private pending = "";
  /** The last brushable command the toolbar ran, for arming without a probe. */
  private lastFormat = "";
  private armed = false;
  private notice: Notice | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
  }

  enable(): void {
    // A released mouse button or a keyboard selection is what "apply" reads;
    // `selectionchange` covers touch, where mouseup is unreliable.
    this.plugin.registerDomEvent(document, "mouseup", (event: MouseEvent) => {
      if (event.button === 0) this.applyIfArmed();
    });
    this.plugin.registerDomEvent(document, "keyup", (event: KeyboardEvent) => {
      if (event.shiftKey || SELECTION_KEYS.has(event.code)) this.applyIfArmed();
    });
    this.plugin.registerDomEvent(
      document,
      "selectionchange",
      debounce(() => this.applyIfArmed(), 100)
    );
    // Right-click is the reference's exit gesture: disarm and swallow that one
    // context menu, so exiting does not also open Obsidian's own menu.
    this.plugin.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      if (!this.armed) return;
      event.preventDefault();
      event.stopPropagation();
      this.disarm();
    });
  }

  /** Whether the brush is currently armed. */
  isActive(): boolean {
    return this.armed;
  }

  /**
   * Called by the editor toolbar after a command ran. Everything is recorded
   * and filtered here, so the toolbar does not have to know the whitelist.
   */
  record(commandId: string): void {
    if (isBrushableCommand(commandId)) this.lastFormat = commandId;
  }

  toggle(): void {
    if (this.armed) {
      this.disarm();
      return;
    }

    let commandId = "";
    const editor = this.activeEditor();
    if (editor && editor.somethingSelected()) {
      commandId = detectFormatFromSelection(editor.getSelection());
    }
    if (!commandId) commandId = this.lastFormat;
    if (!commandId) {
      new Notice(t("notice.brushNoFormat"));
      return;
    }

    this.pending = commandId;
    this.armed = true;
    document.body.classList.add(BRUSH_ACTIVE_CLASS);
    this.notice = new Notice(
      t("notice.brushOn", { format: commandName(this.plugin.app, commandId) || commandId }),
      0
    );
  }

  /** Leaves brush mode, taking the cursor class and the sticky notice with it. */
  disarm(): void {
    this.armed = false;
    this.pending = "";
    document.body.classList.remove(BRUSH_ACTIVE_CLASS);
    if (this.notice) {
      this.notice.hide();
      this.notice = null;
    }
  }

  private applyIfArmed(): void {
    if (!this.armed) return;
    const editor = this.activeEditor();
    // A plain click collapses a lingering selection before this runs, so only
    // a genuinely new selection (or an extended one) reaches the apply.
    if (!editor || !editor.hasFocus() || !editor.somethingSelected()) return;
    const commandId = this.pending;
    if (commandId) runCommand(this.plugin.app, commandId);
    // Deliberately stays armed, as the reference does: the brush keeps going
    // until the user right-clicks or presses the button again.
  }

  private activeEditor(): Editor | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.editor : null;
  }
}
