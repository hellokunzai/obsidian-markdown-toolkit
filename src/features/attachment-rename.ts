import {
  Notice,
  TFile,
  normalizePath,
  type App,
  type TAbstractFile,
} from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { t } from "../i18n";
import {
  handleEmptyFolder,
  noteContext,
  resolveDuplicateSeparator,
  resolveFolderTemplate,
  stripExtension,
  uniqueAttachmentPath,
  type SpecialCharRules,
} from "./attachment-paths";

/**
 * Keeps a note's attachment folder in step with the note's name and location.
 *
 * Obsidian fires a single `rename` event for both renames and moves, so this
 * listener classifies the event itself — did the file name change, did the
 * containing folder change — and lets the matching setting gate its own half
 * (`syncAttachmentsOnRename` / `syncAttachmentsOnMove`). A drag into another
 * folder that also changes the name is both at once, so every applicable switch
 * has to be on for it to act.
 *
 * When it does act, the folder the template resolves to (e.g. `assets/OldName`)
 * is renamed to match (e.g. `assets/NewName`), and every file inside it is moved
 * with it. Each move goes through `vault.rename`, which is Obsidian's own
 * mechanism for rewriting every link that pointed at the file — so we never
 * parse wikilinks or markdown links ourselves.
 *
 * The listener only ever acts on `.md` files, so the renames we trigger on the
 * attachments (which are not `.md`) cannot re-enter the handler.
 */
export class AttachmentRenameSync {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.plugin.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) =>
        void this.onRename(file, oldPath)
      )
    );
  }

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== "md") return;

    // `rename` covers both operations, so split the event into the two kinds of
    // change and let each switch govern its own kind.
    const before = noteContext(oldPath);
    const after = noteContext(file.path);
    const wasRenamed = before.basename !== after.basename;
    const wasMoved = before.folder !== after.folder;
    // A no-op path rewrite; nothing to follow.
    if (!wasRenamed && !wasMoved) return;
    if (wasRenamed && !this.plugin.settings.syncAttachmentsOnRename) return;
    if (wasMoved && !this.plugin.settings.syncAttachmentsOnMove) return;

    const template = this.plugin.settings.attachmentFolder.trim();
    // No template → attachments live wherever Obsidian puts them; nothing to sync.
    if (!template) return;
    // A date token makes the folder name non-deterministic over time, so it
    // cannot be reversed safely — skip rather than risk moving the wrong folder.
    if (/\$\{date:/.test(template)) return;

    // Same special-character rules the paste handler used to create the folder,
    // otherwise the reversed paths would not point at what is actually on disk.
    const rules: SpecialCharRules = {
      chars: this.plugin.settings.attachmentSpecialChars,
      replacement: this.plugin.settings.attachmentSpecialCharsReplacement,
    };

    const oldFolder = resolveFolderTemplate(template, before, rules);
    const newFolder = resolveFolderTemplate(template, after, rules);
    if (!oldFolder || !newFolder || oldFolder === newFolder) return;

    const oldFolderObj = this.app.vault.getFolderByPath(oldFolder);
    if (!oldFolderObj) return;

    const files = this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(`${oldFolder}/`));

    const separator = resolveDuplicateSeparator(
      this.plugin.settings.attachmentDuplicateSeparator,
      rules
    );

    let moved = 0;
    for (const f of files) {
      const rel = f.path.slice(oldFolder.length); // leading "/" preserved
      // The dedup helper takes a path *without* extension — it appends the
      // extension itself — so split the name off its folder instead of handing
      // it the whole source path (doing that used to hand back `pic.png.png`).
      const relDir = rel.slice(0, rel.length - f.name.length);
      const dest = normalizePath(`${newFolder}${relDir}${stripExtension(f.name)}`);
      const available = uniqueAttachmentPath(this.app, dest, f.extension, separator);
      try {
        await this.app.vault.rename(f, available);
        moved++;
      } catch (err) {
        console.error("MarkdownEditorPlus: attachment move on rename failed", err);
      }
    }

    if (moved > 0) {
      new Notice(t("attachment.renamedMoved", { count: moved }));
      await handleEmptyFolder(
        this.app,
        oldFolder,
        this.plugin.settings.emptyFolderHandling
      );
    }
  }
}
