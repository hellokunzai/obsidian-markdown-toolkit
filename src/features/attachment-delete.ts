import {
  Notice,
  TFile,
  type App,
  type TAbstractFile,
} from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { t } from "../i18n";
import {
  handleEmptyFolder,
  isAttachment,
  isReferencedBy,
  noteContext,
  resolveFolderTemplate,
  type SpecialCharRules,
} from "./attachment-paths";

/**
 * Deletes a note's orphaned attachments when the note itself is deleted.
 *
 * The behavior mirrors the "delete orphaned attachments" preference in
 * attachment-management style plugins: off by default, opt in from settings.
 * Only the folder the template resolves to is scanned, and only files that no
 * surviving note references are touched. Files go to the trash (recoverable),
 * never a permanent delete.
 *
 * The just-deleted note's own backlinks may still sit in the metadata cache,
 * so its path is explicitly excluded from the reference check.
 */
export class AttachmentDeleteSync {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.plugin.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) =>
        void this.onDelete(file)
      )
    );
  }

  private async onDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!this.plugin.settings.deleteOrphanedOnNoteDelete) return;

    const template = this.plugin.settings.attachmentFolder.trim();
    // No template → Obsidian chooses the location; nothing of ours to sweep.
    if (!template) return;
    // A date token makes the folder non-deterministic, so it cannot be
    // resolved for a note that no longer exists — skip rather than guess.
    if (/\$\{date:/.test(template)) return;

    // Mirror the special-character rules the save path applied, so the reversed
    // folder is the one the note's attachments actually live in.
    const rules: SpecialCharRules = {
      chars: this.plugin.settings.attachmentSpecialChars,
      replacement: this.plugin.settings.attachmentSpecialCharsReplacement,
    };

    const folder = resolveFolderTemplate(template, noteContext(file.path), rules);
    if (!folder) return;

    const excluded = new Set([file.path]);
    const orphans = this.app.vault
      .getFiles()
      .filter(
        (f) =>
          f.path.startsWith(`${folder}/`) &&
          isAttachment(f) &&
          !isReferencedBy(this.app, f, excluded)
      );

    if (orphans.length > 0) {
      let deleted = 0;
      for (const f of orphans) {
        try {
          await this.app.vault.trash(f, true);
          deleted++;
        } catch (err) {
          console.error("MarkdownEditorPlus: orphaned attachment delete failed", err);
        }
      }
      if (deleted > 0) {
        new Notice(t("attachment.orphanDone", { count: deleted }));
      }
    }

    await handleEmptyFolder(
      this.app,
      folder,
      this.plugin.settings.emptyFolderHandling
    );
  }
}
