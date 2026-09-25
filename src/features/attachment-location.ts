import {
  Notice,
  TFile,
  normalizePath,
  type App,
  type Editor,
  type MarkdownView,
  type MarkdownFileInfo,
} from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { t } from "../i18n";
import {
  applyTemplate,
  noteContext,
  resolveDuplicateSeparator,
  resolveFolderTemplate,
  sanitizeName,
  stripExtension,
  uniqueAttachmentPath,
  type NoteContext,
  type SpecialCharRules,
} from "./attachment-paths";

/**
 * Globally intercepts paste / drop of files into Markdown editors and routes the
 * saved location and file name through the plugin's own templates, replacing
 * Obsidian's built-in "Pasted image …" behaviour.
 *
 * The `editor-paste` / `editor-drop` handlers return `true`, which tells
 * Obsidian to skip its own file handling entirely — so there is never a second
 * "Pasted image" file written alongside ours. The actual save is async (reading
 * a `File` into an `ArrayBuffer` has no synchronous API), so the default is
 * blocked synchronously with `preventDefault` and the write is kicked off in the
 * background.
 */

// Extensions Obsidian renders inline with a leading "!". Anything else is linked
// as a normal file reference.
const EMBED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp",
  "mp3", "webm", "ogg", "wav", "m4a", "3gp", "flac",
  "mp4", "mov", "ogv", "mkv", "avi",
  "pdf",
]);

const WINDOWS_FORBIDDEN = /[\\:*?"<>|]+/g;

export class AttachmentLocation {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.plugin.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, view) =>
        this.intercept(evt, editor, view)
      )
    );
    this.plugin.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, view) =>
        this.intercept(evt, editor, view)
      )
    );
  }

  private intercept(
    evt: ClipboardEvent | DragEvent,
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo
  ): boolean {
    const files = this.extractFiles(evt);
    // No files means a plain-text paste/drop — leave it for Obsidian.
    if (files.length === 0) return false;

    // Block the default synchronously; the save runs async below.
    evt.preventDefault();
    void this.saveAndInsert(files, editor, view);
    return true;
  }

  private extractFiles(evt: ClipboardEvent | DragEvent): File[] {
    const data =
      "clipboardData" in evt ? evt.clipboardData : evt.dataTransfer;
    if (!data) return [];
    return Array.from(data.files ?? []);
  }

  private async saveAndInsert(
    files: File[],
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo
  ): Promise<void> {
    const noteFile = view.file ?? this.app.workspace.getActiveFile();
    if (!noteFile) {
      new Notice(t("notice.noActiveFile"));
      return;
    }
    const note = noteContext(noteFile.path);

    // Capture the selection synchronously: the async save resolves later, by
    // which point the user's selection may well have changed.
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");

    const links: string[] = [];
    for (const file of files) {
      try {
        const saved = await this.saveOne(file, note, noteFile);
        links.push(this.buildLink(saved, noteFile.path));
      } catch (err) {
        console.error("MarkdownEditorPlus: attachment save failed", err);
        new Notice(t("attachment.saveFailed", { name: file.name }));
      }
    }

    if (links.length > 0) {
      editor.replaceRange(links.join("\n"), from, to);
    }
  }

  private async saveOne(
    file: File,
    note: NoteContext,
    noteFile: TFile
  ): Promise<TFile> {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const originalBase = stripExtension(file.name);

    const rules = this.specialCharRules();
    const folderDir = resolveFolderTemplate(
      this.plugin.settings.attachmentFolder,
      note,
      rules
    );
    const baseName = this.resolveFileName(
      this.plugin.settings.attachmentTemplate,
      note,
      originalBase,
      rules
    );

    const vault = this.app.vault as unknown as {
      getAvailablePathForAttachments(base: string, ext: string, note: TFile): Promise<string>;
      exists(path: string): Promise<boolean>;
      createFolder(path: string): Promise<void>;
      createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
    };

    // The folder comes from our template, or — when that is empty — from the
    // app's own attachment location. In the second case we borrow only the
    // folder it picked; the file name and the duplicate separator stay ours.
    let dir = folderDir;
    if (dir === null) {
      const probe = await vault.getAvailablePathForAttachments(baseName, ext, noteFile);
      const slash = probe.lastIndexOf("/");
      dir = slash > 0 ? probe.slice(0, slash) : "";
    }

    const candidate = normalizePath(dir === "" ? baseName : `${dir}/${baseName}`);
    const finalPath = uniqueAttachmentPath(
      this.app,
      candidate,
      ext,
      resolveDuplicateSeparator(
        this.plugin.settings.attachmentDuplicateSeparator,
        rules
      )
    );

    const finalDir = finalPath.slice(0, finalPath.lastIndexOf("/"));
    if (finalDir && !(await vault.exists(finalDir))) {
      await vault.createFolder(finalDir);
    }

    const buffer = await file.arrayBuffer();
    return await vault.createBinary(finalPath, buffer);
  }

  private specialCharRules(): SpecialCharRules {
    return {
      chars: this.plugin.settings.attachmentSpecialChars,
      replacement: this.plugin.settings.attachmentSpecialCharsReplacement,
    };
  }

  private resolveFileName(
    template: string,
    note: NoteContext,
    originalBase: string,
    rules: SpecialCharRules
  ): string {
    const tpl =
      template && template.trim()
        ? template
        : "file-${date:YYYYMMDDHHmmssSSS}";
    return sanitizeName(
      applyTemplate(tpl, {
        noteFileName: note.basename,
        folderPath: note.folder,
        originalFileName: originalBase,
      }),
      rules
    )
      // Last-resort net for characters no file system accepts, in case the user
      // cleared the special-character list above.
      .replace(WINDOWS_FORBIDDEN, "-")
      .replace(/\/+/g, "-")
      .replace(/^\.+|\.+$/g, "")
      .trim();
  }

  private buildLink(file: TFile, sourcePath: string): string {
    const raw = this.app.fileManager.generateMarkdownLink(file, sourcePath);
    if (
      EMBED_EXTENSIONS.has(file.extension.toLowerCase()) &&
      !raw.startsWith("!")
    ) {
      return "!" + raw;
    }
    return raw;
  }
}
