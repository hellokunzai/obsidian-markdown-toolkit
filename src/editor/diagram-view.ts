import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { VIEW_TYPE_DIAGRAM } from "./view-type";
import type MarkdownEditorPlusPlugin from "../main";
import type { EditorSession } from "./editor-session";

/**
 * The full-tab home of an editor session.
 *
 * It owns no editor state: it looks the session up by id and lets the session
 * move its panel in. That is what makes "open as a tab" a move rather than a
 * second, divergent editor.
 *
 * A session id that no longer resolves (for example a layout restored after a
 * restart, where the note's block is long gone) makes the leaf close itself
 * instead of showing an empty shell.
 */
export class DiagramView extends ItemView {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private session: EditorSession | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MarkdownEditorPlusPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DIAGRAM;
  }

  getDisplayText(): string {
    return t("view.title");
  }

  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    const state = this.leaf.getViewState().state as { sessionId?: string } | undefined;
    const session = state?.sessionId ? this.plugin.find(state.sessionId) : null;
    this.contentEl.classList.add("mtk-view-host");
    if (!session) {
      this.contentEl.classList.add("mtk-view-stale");
      this.leaf.detach();
      return;
    }
    this.session = session;
    session.attachPanel(this.contentEl, true);
  }

  async onClose(): Promise<void> {
    this.contentEl.classList.remove("mtk-view-host", "mtk-in-tab");
    // Only a tab that is closing while the session still lives there ends it; a
    // detach that is part of collapsing back into a dialog must leave it alone.
    if (this.session && this.session.where === "tab") this.session.finish();
    this.session = null;
  }
}
