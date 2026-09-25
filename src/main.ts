import {
  Notice,
  Plugin,
  type Editor,
  type EditorPosition,
  type MarkdownFileInfo,
  type MarkdownView,
} from "obsidian";
import { t } from "./i18n";
import { DEFAULT_SETTINGS, MarkdownEditorPlusSettingTab, type MarkdownEditorPlusSettings } from "./settings";
import {
  registerDiagramBlocks,
  type DiagramBlockHost,
  type OpenEditorRequest,
  type Repaintable,
} from "./embed/reading-processor";
import { EditorSession, type SessionRegistry } from "./editor/editor-session";
import { livePreviewExtension, refreshLivePreview } from "./embed/live-preview";
import { DiagramView } from "./editor/diagram-view";
import { VIEW_TYPE_DIAGRAM } from "./editor/view-type";
import { listFences, siblingFences, type BlockTarget } from "./block/block-target";
import { outlineToMindmapBody } from "./core/outline";
import { detectMode } from "./core/parse";
import { MERMAID_LANG, type FlowDirection, type MindmapLayout } from "./core/model";
import { migrateToolbarCommandIds, sanitizeToolbarCommands } from "./core/toolbar-commands";
import { kindById, type DiagramKind } from "./core/kinds";
import { DiagramKindPicker } from "./ui/kind-picker";
import { EditorToolbar } from "./features/editor-toolbar";
import { FormatBrush } from "./features/format-brush";
import { toggleUnderline } from "./features/underline";
import { runTextTool, TEXT_TOOL_COMMAND_PREFIX } from "./features/text-tools";
import { TEXT_TOOLS } from "./core/text-tools";
import { applyTextAlign, TEXT_ALIGN_COMMAND_PREFIX } from "./features/text-align";
import { ALIGN_TOOLS } from "./core/text-align";
import { openFontColorPicker } from "./features/font-color";
import { FONT_COLOR_ICON } from "./core/font-color";
import { openBackgroundColorPicker } from "./features/background-color";
import { BACKGROUND_COLOR_ICON } from "./core/background-color";
import { registerColorIcons } from "./ui/color-picker";
import { FocusMode } from "./features/focus-mode";
import { FOCUS_MODE_ICON } from "./core/focus-mode";
import { HideRules } from "./features/hide-rules";
import { FileOrder } from "./features/file-order";
import { migrateOrders } from "./features/order-store";
import { AttachmentLocation } from "./features/attachment-location";
import { AttachmentDeleteSync } from "./features/attachment-delete";
import { AttachmentRenameSync } from "./features/attachment-rename";

/**
 * `editorCallback` hands back either a `MarkdownView` or a bare
 * `MarkdownFileInfo`. Every command below only reads `ctx.file?.path`, so
 * narrowing to `MarkdownView` would be an invented restriction that the API
 * does not actually guarantee.
 */
type EditorContext = MarkdownView | MarkdownFileInfo;

const DIRECTIONS: FlowDirection[] = ["TD", "BT", "LR", "RL"];
const LAYOUTS: MindmapLayout[] = ["right", "left", "both"];

/**
 * The regular-expression default of 0.5.x, translated once.
 *
 * `^\.` is not a name, so under the name-based rules it would match nothing and
 * the dotfile rule would quietly vanish from an existing `data.json`. Only the
 * one value that shipped as a default is translated: a regular expression
 * cannot be turned into a name rule in general, and a guess would be worse than
 * leaving the old text visible in the box for the user to rewrite.
 */
function migrateHiddenRules(value: string): string {
  return value.trim() === "^\\." ? DEFAULT_SETTINGS.hiddenRules : value;
}

export default class MarkdownEditorPlusPlugin extends Plugin implements DiagramBlockHost, SessionRegistry {
  settings!: MarkdownEditorPlusSettings;

  private readonly sessions = new Map<string, EditorSession>();
  private readonly blocks = new Set<Repaintable>();
  private hideRules: HideRules | null = null;
  private editorToolbar: EditorToolbar | null = null;

  /**
   * Manual ordering in the file explorer.
   *
   * Held rather than fired and forgotten, because it owns a patch it has left
   * on the explorer's prototype: the plugin being switched off has to take that
   * patch back out, or a closure from an unloaded plugin keeps sorting the tree.
   */
  private fileOrder: FileOrder | null = null;

  /**
   * 0.16.0 fullscreen focus mode.
   *
   * Held rather than fired and forgotten: `unload` has to hand the screen back
   * and put the overlays it carried into the fullscreen element where they were,
   * and neither it nor the toolbar knows about the other.
   */
  private focusMode: FocusMode | null = null;

  /**
   * 0.9.0 format painter. The toolbar hands every executed command to this,
   * and the brush filters by its own whitelist — not assigned here, so the
   * settings tab can keep using a bare plugin mock in tests.
   */
  formatBrush: FormatBrush | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Before anything can draw them: both colour buttons' glyphs are this
    // plugin's own, and `setIcon` renders nothing at all for an unknown name.
    registerColorIcons();

    registerDiagramBlocks(this, this);
    // The reading view is served by the code block processor above; the editor
    // needs its own extension, because Live Preview draws mermaid itself before
    // plugin post processing ever runs.
    this.registerEditorExtension(livePreviewExtension(this));
    this.registerView(VIEW_TYPE_DIAGRAM, (leaf) => new DiagramView(leaf, this));
    this.addSettingTab(new MarkdownEditorPlusSettingTab(this.app, this));

    // Editor-explorer enhancements added in 0.4.0. The instance is kept rather
    // than dropped, because the settings tab has to be able to repaint the bar
    // as soon as a command is added, renamed, reordered or removed.
    this.editorToolbar = new EditorToolbar(this);
    this.editorToolbar.enable();

    // 0.9.0 format painter, enabled before the toolbar so the first click on
    // a toolbar button can already be recorded.
    this.formatBrush = new FormatBrush(this);
    this.formatBrush.enable();
    this.hideRules = new HideRules(this);
    this.hideRules.enable();
    this.fileOrder = new FileOrder(this);
    this.fileOrder.enable();

    // 0.16.0 fullscreen focus mode. Nothing to enable: it has no listeners of
    // its own until the mode is actually entered, and the ones it then adds have
    // to belong to the window being made fullscreen.
    this.focusMode = new FocusMode();

    // Attachment location override added in 0.5.0.
    new AttachmentLocation(this).enable();

    // Attachment housekeeping added in 0.5.1: settings-driven orphan cleanup
    // on note delete, plus attachment-folder sync when a note is renamed.
    new AttachmentDeleteSync(this).enable();
    new AttachmentRenameSync(this).enable();

    this.addCommand({
      id: "insert-mindmap",
      name: t("command.insertMindmap"),
      editorCallback: (editor, ctx) => this.insertKind(editor, ctx, kindById("mindmap")),
    });
    this.addCommand({
      id: "insert-flow",
      name: t("command.insertFlow"),
      editorCallback: (editor, ctx) => this.insertKind(editor, ctx, kindById("flowchart")),
    });
    this.addCommand({
      id: "insert-any",
      name: t("command.insertAny"),
      editorCallback: (editor, ctx) => this.pickKind(editor, ctx),
    });
    this.addCommand({
      id: "outline-to-mindmap",
      name: t("command.outlineToMindmap"),
      editorCallback: (editor, ctx) => this.outlineToMindmap(editor, ctx),
    });
    this.addCommand({
      id: "edit-at-cursor",
      name: t("command.editAtCursor"),
      editorCallback: (editor, ctx) => this.editAtCursor(editor, ctx),
    });
    // 0.9.0 format painter, ported from obsidian-editing-toolbar.
    this.addCommand({
      id: "toggle-format-brush",
      name: t("command.toggleFormatBrush"),
      icon: "paintbrush",
      editorCallback: () => this.formatBrush?.toggle(),
    });
    // Markdown has no underline, so this is the plugin's own command writing
    // the HTML tag Obsidian renders; it is what the toolbar's underline button
    // and the format brush both point at.
    this.addCommand({
      id: "toggle-underline",
      name: t("command.toggleUnderline"),
      icon: "underline",
      editorCallback: (editor) => toggleUnderline(editor),
    });

    // One command per text tool, driven by the same catalog the toolbar's
    // 文本工具 submenu is built from — so a tool cannot end up in the menu
    // without a command behind it, or the other way round.
    for (const entry of TEXT_TOOLS) {
      this.addCommand({
        id: `${TEXT_TOOL_COMMAND_PREFIX}${entry.slug}`,
        name: t(entry.nameKey),
        icon: entry.icon,
        editorCallback: (editor) => runTextTool(this.app, editor, entry.slug),
      });
    }

    // The four alignments, registered from the same catalog the toolbar's
    // 文本对齐 submenu is built from — so the two cannot drift apart, and each
    // one is reachable from the command palette and a hotkey as well.
    for (const entry of ALIGN_TOOLS) {
      this.addCommand({
        id: `${TEXT_ALIGN_COMMAND_PREFIX}${entry.slug}`,
        name: t(entry.nameKey),
        icon: entry.icon,
        editorCallback: (editor) => applyTextAlign(editor, entry.slug),
      });
    }

    // Font colour. One command, not one per swatch: the colour is chosen after
    // the command runs, in the panel. The toolbar's press reaches the same
    // panel through `features/editor-toolbar`, anchored to the button instead
    // of to the caret — see `colorPanelFor`.
    this.addCommand({
      id: "change-font-color",
      name: t("command.fontColor"),
      icon: FONT_COLOR_ICON,
      editorCallback: (editor) => openFontColorPicker(editor, null),
    });

    // Background colour, the same shape one step further along: the same panel
    // with a different palette, five circles to a row instead of ten squares.
    this.addCommand({
      id: "change-background-color",
      name: t("command.backgroundColor"),
      icon: BACKGROUND_COLOR_ICON,
      editorCallback: (editor) => openBackgroundColorPicker(editor, null),
    });

    // Fullscreen focus mode. The reference plugin ships two of these; the other
    // one only collapses the sidebars, which is not what a button labelled
    // fullscreen should do. No `hotkeys` here on purpose — the reference binds
    // Ctrl+Shift+F11, and that key is left free.
    this.addCommand({
      id: "toggle-focus-mode",
      name: t("command.focusMode"),
      icon: FOCUS_MODE_ICON,
      callback: () => this.focusMode?.toggle(),
    });

    // SVG paints are baked-in attributes rather than CSS, so a theme switch has
    // to trigger a repaint in every live block and editor.
    this.registerEvent(this.app.workspace.on("css-change", () => this.repaintAll()));
  }

  onunload(): void {
    // First, because it is the only thing that can give the screen back: if the
    // plugin is disabled while the mode is on, the fullscreen element is one
    // only this class knows how to unwind, overlays included.
    this.focusMode?.unload();
    this.focusMode = null;
    this.editorToolbar?.unload();
    this.editorToolbar = null;
    // Takes the body class and the sticky notice down with the plugin.
    this.formatBrush?.disarm();
    this.formatBrush = null;
    this.hideRules?.unload();
    this.hideRules = null;
    // Takes the sorting patch off the explorer's prototype with it. Left in
    // place, the closure would go on sorting a tree whose plugin is gone.
    this.fileOrder?.unload();
    this.fileOrder = null;
    for (const session of [...this.sessions.values()]) session.finish();
    this.sessions.clear();
    this.blocks.clear();
  }

  /**
   * Re-applies the hidden-entry settings and writes whatever changed.
   *
   * The settings tab calls this after every edit: a rule change has to reach the
   * file explorer while the panel is still open, and the excluded-files list it
   * may write has to be persisted in the same breath, or a rule the user has
   * since deleted would no longer be removable from that list.
   */
  async refreshHideRules(): Promise<void> {
    this.hideRules?.refresh();
    await this.saveSettings();
  }

  /**
   * Repaints the toolbar pinned above the editor.
   *
   * The settings tab owns the command list while the bar lives in the editor,
   * so without this a change would only be visible after the active leaf
   * happened to change and the toolbar re-pinned itself.
   */
  refreshToolbar(): void {
    this.editorToolbar?.sync();
  }

  /* ------------------------------------------------------------- settings */

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<MarkdownEditorPlusSettings> | null;
    // The custom order changed shape in 0.19.0: one mixed list per folder became
    // two, one per kind, and the vault root's key went from "" to "/". Both are
    // converted here rather than at the point of use, so the rest of the code
    // only ever sees the current shape.
    const orders = migrateOrders(saved?.orderMap);
    /* The reorder switch was renamed in 0.20.0. It used to mean "manual sorting
       is on" — handles on every row, drags allowed — and it now means "the
       toolbar button is showing", with the button itself carrying the on/off of
       the mode. A vault that had the old switch on is carried over with the
       button *and* the mode on, which is the state it was already in rather
       than one that looks as if the feature was switched off underneath it; a
       vault that had it off lands on both defaults either way. */
    const legacyOrderEnabled =
      (saved as { orderEnabled?: unknown } | null)?.orderEnabled === true;
    const orderButton =
      typeof saved?.orderButton === "boolean" ? saved.orderButton : legacyOrderEnabled;
    const orderMode =
      typeof saved?.orderMode === "boolean" ? saved.orderMode : legacyOrderEnabled;
    // Copied field by field rather than merged: a `data.json` written by an
    // earlier version still carries the retired block-language keys, and those
    // are better dropped than carried around forever. Every value is checked
    // against its allowed set, because a hand-edited `data.json` must never be
    // able to put the UI into a state its own dropdowns cannot express.
    this.settings = {
      flowDirection: DIRECTIONS.includes(saved?.flowDirection as FlowDirection)
        ? (saved?.flowDirection as FlowDirection)
        : DEFAULT_SETTINGS.flowDirection,
      mindmapLayout: LAYOUTS.includes(saved?.mindmapLayout as MindmapLayout)
        ? (saved?.mindmapLayout as MindmapLayout)
        : DEFAULT_SETTINGS.mindmapLayout,
      persistPositions: saved?.persistPositions ?? DEFAULT_SETTINGS.persistPositions,
      openIn: saved?.openIn === "tab" ? "tab" : DEFAULT_SETTINGS.openIn,

      // 0.4.0 editor-explorer features. Field-by-field so a data.json written
      // by an earlier release (which still carries the retired block-language
      // keys) drops those and picks up these with their defaults.
      // Validated rather than merely filtered: the list nests now, so a
      // hand-edited data.json could otherwise hand the settings tab a submenu
      // with no id, a three-level tree, or two rows claiming the same id. The
      // sanitiser also rebuilds every entry, which is what stops a later edit
      // from writing through to the module-level defaults.
      // Migration, not validation: a `data.json` written before the rename
      // holds this plugin's own two buttons under the old prefix, and the
      // sanitiser would keep them as ids nothing is registered under. The
      // prefix comes from the manifest so it cannot disagree with the id the
      // commands are actually registered with.
      toolbarCommands: migrateToolbarCommandIds(
        sanitizeToolbarCommands(
          Array.isArray(saved?.toolbarCommands) ? saved.toolbarCommands : DEFAULT_SETTINGS.toolbarCommands
        ),
        `${this.manifest.id}:`
      ),
      hiddenRules:
        typeof saved?.hiddenRules === "string"
          ? migrateHiddenRules(saved!.hiddenRules)
          : DEFAULT_SETTINGS.hiddenRules,
      hiddenEnabled:
        typeof saved?.hiddenEnabled === "boolean"
          ? saved!.hiddenEnabled
          : DEFAULT_SETTINGS.hiddenEnabled,
      hiddenIgnoreCase:
        typeof saved?.hiddenIgnoreCase === "boolean"
          ? saved!.hiddenIgnoreCase
          : DEFAULT_SETTINGS.hiddenIgnoreCase,
      hiddenExcludeList:
        typeof saved?.hiddenExcludeList === "boolean"
          ? saved!.hiddenExcludeList
          : DEFAULT_SETTINGS.hiddenExcludeList,
      hiddenStatusBar:
        typeof saved?.hiddenStatusBar === "boolean"
          ? saved!.hiddenStatusBar
          : DEFAULT_SETTINGS.hiddenStatusBar,
      hiddenExcludeEntries: Array.isArray(saved?.hiddenExcludeEntries)
        ? saved!.hiddenExcludeEntries.filter((entry): entry is string => typeof entry === "string")
        : DEFAULT_SETTINGS.hiddenExcludeEntries,
      orderButton,
      /* Never left on behind a hidden button: a mode with nothing to press it
         with could neither be seen nor left. `settings.ts` keeps this true on
         its own side too, for files that did not come through here. */
      orderMode: orderButton && orderMode,
      orderMap: orders.orders,
      attachmentTemplate:
        typeof saved?.attachmentTemplate === "string"
          ? saved!.attachmentTemplate
          : DEFAULT_SETTINGS.attachmentTemplate,
      attachmentFolder:
        typeof saved?.attachmentFolder === "string"
          ? saved!.attachmentFolder
          : DEFAULT_SETTINGS.attachmentFolder,
      attachmentSpecialChars:
        typeof saved?.attachmentSpecialChars === "string"
          ? saved!.attachmentSpecialChars
          : DEFAULT_SETTINGS.attachmentSpecialChars,
      attachmentSpecialCharsReplacement:
        typeof saved?.attachmentSpecialCharsReplacement === "string"
          ? saved!.attachmentSpecialCharsReplacement
          : DEFAULT_SETTINGS.attachmentSpecialCharsReplacement,
      syncAttachmentsOnRename:
        typeof saved?.syncAttachmentsOnRename === "boolean"
          ? saved!.syncAttachmentsOnRename
          : DEFAULT_SETTINGS.syncAttachmentsOnRename,
      syncAttachmentsOnMove:
        typeof saved?.syncAttachmentsOnMove === "boolean"
          ? saved!.syncAttachmentsOnMove
          : DEFAULT_SETTINGS.syncAttachmentsOnMove,
      attachmentDuplicateSeparator:
        typeof saved?.attachmentDuplicateSeparator === "string"
          ? saved!.attachmentDuplicateSeparator
          : DEFAULT_SETTINGS.attachmentDuplicateSeparator,
      emptyFolderHandling:
        saved?.emptyFolderHandling === "keep" ||
        saved?.emptyFolderHandling === "delete" ||
        saved?.emptyFolderHandling === "delete-and-parents"
          ? saved!.emptyFolderHandling
          : DEFAULT_SETTINGS.emptyFolderHandling,
      deleteOrphanedOnNoteDelete:
        typeof saved?.deleteOrphanedOnNoteDelete === "boolean"
          ? saved!.deleteOrphanedOnNoteDelete
          : DEFAULT_SETTINGS.deleteOrphanedOnNoteDelete,
    };

    // Written back the moment it is converted, so the migration happens once
    // rather than on every load — and so a settings file that has been carried
    // forward is not still advertising the old shape.
    if (orders.migrated) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Applies the manual-order settings and writes whatever changed.
   *
   * Switching the feature on installs the sorting patch over the explorer's own
   * sorter; switching it off takes the patch back out and lets the rows fall
   * back into Obsidian's order. Both are side effects rather than stored flags,
   * so the settings panel goes through here instead of writing the value itself.
   */
  async refreshFileOrder(): Promise<void> {
    this.fileOrder?.sync();
    await this.saveSettings();
  }

  /* --------------------------------------------------------------- blocks */

  trackBlock(block: Repaintable): void {
    this.blocks.add(block);
  }

  untrackBlock(block: Repaintable): void {
    this.blocks.delete(block);
  }

  private repaintAll(): void {
    for (const block of this.blocks) block.repaint();
    for (const session of this.sessions.values()) session.panel.repaintForTheme();
    refreshLivePreview();
  }

  /* -------------------------------------------------------------- sessions */

  find(id: string): EditorSession | null {
    return this.sessions.get(id) ?? null;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * Opens the visual editor for one fenced block.
   *
   * A second editor on the same block would mean two sources of truth for one
   * piece of text, so an editor already open on that block is closed first.
   */
  openEditor(request: OpenEditorRequest): void {
    const key = this.sessionKey(request.target);
    this.sessions.get(key)?.finish();

    const session = new EditorSession(this.app, this, key, {
      target: request.target,
      source: request.source,
      mode: request.mode,
      persistPositions: this.settings.persistPositions,
      mindmapLayout: this.settings.mindmapLayout,
      flowDirection: this.settings.flowDirection,
      openIn: this.settings.openIn,
    });
    this.sessions.set(key, session);
    session.start();
  }

  /**
   * The index is counted per diagram kind, not per fence language — every
   * diagram shares one language now, so the kind is what makes a block unique.
   */
  private sessionKey(target: BlockTarget): string {
    return `${target.path}\u0000${target.mode}\u0000${target.index ?? "?"}`;
  }

  /* -------------------------------------------------------------- commands */

  private activePath(ctx: EditorContext): string | null {
    return ctx.file?.path ?? this.app.workspace.getActiveFile()?.path ?? null;
  }

  /**
   * Writes a new block of the given kind, then opens it in the visual editor.
   *
   * Every kind in the table has a canvas, so an inserted block always opens;
   * the template is what the editor starts from rather than what the user is
   * left holding.
   *
   * `range` is supplied by the picker, which holds focus while it is open. The
   * cursor is still where the user left it, but reading it back after a modal
   * closes is a race worth not running.
   */
  private insertKind(
    editor: Editor,
    ctx: EditorContext,
    kind: DiagramKind,
    range?: { from: EditorPosition; to: EditorPosition }
  ): void {
    const path = this.activePath(ctx);
    if (!path) {
      new Notice(t("notice.noActiveFile"));
      return;
    }

    const from = range?.from ?? editor.getCursor("from");
    const to = range?.to ?? editor.getCursor("to");
    const body = t(kind.templateKey).replace(/\n+$/, "");
    const head = editor.getLine(from.line).slice(0, from.ch);
    const tail = editor.getLine(to.line).slice(to.ch);
    const lead = head.trim().length > 0 ? "\n" : "";
    const trail = tail.trim().length > 0 ? "\n" : "";
    editor.replaceRange(`${lead}\`\`\`${MERMAID_LANG}\n${body}\n\`\`\`${trail}`, from, to);

    const fenceLine = from.line + (lead ? 1 : 0);
    const fences = siblingFences(editor.getValue(), { lang: MERMAID_LANG, mode: kind.mode });
    const index = fences.findIndex((fence) => fence.startLine === fenceLine);
    this.openEditor({
      target: {
        path,
        lang: MERMAID_LANG,
        mode: kind.mode,
        index: index >= 0 ? index : null,
        body,
      },
      source: body,
      mode: kind.mode,
    });
  }

  /** Shows the type list; the block is written once a kind is chosen. */
  private pickKind(editor: Editor, ctx: EditorContext): void {
    if (!this.activePath(ctx)) {
      new Notice(t("notice.noActiveFile"));
      return;
    }
    const range = { from: editor.getCursor("from"), to: editor.getCursor("to") };
    new DiagramKindPicker(this.app, (kind) => this.insertKind(editor, ctx, kind, range)).open();
  }

  private outlineToMindmap(editor: Editor, ctx: EditorContext): void {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.outlineEmpty"));
      return;
    }
    const path = this.activePath(ctx);
    if (!path) {
      new Notice(t("notice.noActiveFile"));
      return;
    }

    const fallbackRoot = selection.split(/\r?\n/).find((line) => line.trim()) ?? "";
    const body = outlineToMindmapBody(selection, (ctx.file?.basename ?? fallbackRoot).trim());
    if (!body) {
      new Notice(t("notice.outlineEmpty"));
      return;
    }

    const from = editor.getCursor("from");
    editor.replaceSelection(`\`\`\`${MERMAID_LANG}\n${body}\n\`\`\`\n`);
    new Notice(t("notice.outlineCreated", { count: Math.max(0, body.split(/\r?\n/).length - 1) }));

    const fences = siblingFences(editor.getValue(), { lang: MERMAID_LANG, mode: "mindmap" });
    const index = fences.findIndex((fence) => fence.startLine === from.line);
    this.openEditor({
      target: { path, lang: MERMAID_LANG, mode: "mindmap", index: index >= 0 ? index : null, body },
      source: body,
      mode: "mindmap",
    });
  }

  private editAtCursor(editor: Editor, ctx: EditorContext): void {
    const path = this.activePath(ctx);
    if (!path) {
      new Notice(t("notice.noActiveFile"));
      return;
    }
    const line = editor.getCursor().line;
    const text = editor.getValue();
    // Only blocks this plugin can draw. `detectMode` returns null for a mermaid
    // keyword outside our table, and such a block belongs to mermaid itself.
    const mine = listFences(text).filter(
      (fence) => fence.lang === MERMAID_LANG && detectMode(fence.body) !== null
    );
    const fence = mine.find((candidate) => candidate.startLine < line && line < candidate.endLine);
    if (!fence) {
      new Notice(t("notice.noBlockAtCursor"));
      return;
    }
    // Asked again rather than cast: the filter above is a runtime promise, and
    // a second call is both cheaper than a cast and honest about it.
    const mode = detectMode(fence.body);
    if (!mode) {
      new Notice(t("notice.noBlockAtCursor"));
      return;
    }
    const siblings = siblingFences(text, { lang: MERMAID_LANG, mode });
    const index = siblings.findIndex((candidate) => candidate.startLine === fence.startLine);
    this.openEditor({
      target: {
        path,
        lang: MERMAID_LANG,
        mode,
        index: index >= 0 ? index : null,
        body: fence.body,
      },
      source: fence.body,
      mode,
    });
  }
}
