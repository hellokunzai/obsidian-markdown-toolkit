/**
 * Writing a table out beside the note it came from, as CSV or as Markdown.
 *
 * The reading view's frame is the caller: its ⬇ opens the menu. This lived
 * inside `table-render.ts` while that file was the only thing that needed it,
 * moved out when the editor panel's view chrome grew its own download entry,
 * and stayed here when that entry was removed — it is the export feature's
 * implementation, and "what a framed table looks like" (the rest of
 * `table-render.ts`) is a different job from writing a file.
 */
import { Menu, Notice, normalizePath, type App, type TFile, type Vault } from "obsidian";
import { t } from "../i18n";
import { serializeCsv, serializeTable, type TableModel } from "../core/table-formula";

/**
 * The formats the download entry offers, as a menu under the button.
 *
 * One button rather than two squares for "CSV" and "Markdown": the corner is a
 * row of 26px squares, and two glyphs that both mean "download" are not two
 * things a reader can tell apart. The menu itself is Obsidian's own `Menu`, so
 * it inherits the theme, the flip-up placement near the window's bottom, Escape
 * to close and keyboard navigation for free — the toolbar's submenus already go
 * through `Menu` for exactly that reason.
 */
export function openTableExportMenu(anchor: HTMLElement, app: App, file: TFile | null, model: TableModel): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(t("table.exportCsv"))
      .setIcon("file-spreadsheet")
      .onClick(() => void writeTableFile(app, file, "csv", model))
  );
  menu.addItem((item) =>
    item
      .setTitle(t("table.exportMd"))
      .setIcon("file-text")
      .onClick(() => void writeTableFile(app, file, "md", model))
  );
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
}

/**
 * Writes the table out beside the note it came from.
 *
 * Mirrors the diagram export's landing rule: a sibling of the note, never a
 * fixed folder, so the file keeps the one piece of context that says which note
 * it belongs to. Failures are reported rather than thrown — this runs from a
 * click handler on a button in a note, and a rejected promise there is an
 * unhandled rejection the user cannot act on.
 */
async function writeTableFile(
  app: App,
  file: TFile | null,
  kind: "csv" | "md",
  model: TableModel
): Promise<void> {
  const path = freeTablePath(app.vault, file, kind);
  const content = kind === "csv" ? serializeCsv(model) : serializeTable(model);
  try {
    await app.vault.create(path, content);
    new Notice(t("notice.exported", { name: path }));
  } catch (error) {
    console.error("MarkdownEditorPlus: table export failed", error);
    new Notice(t("notice.exportFailed"));
  }
}

/**
 * `file`'s folder plus its basename, never taken twice.
 *
 * A note at the vault root has `parent.path === ""` (not `/`), so the two are
 * joined through `normalizePath` — otherwise a root note exports to `//note.csv`
 * and the confirmation reads like a typo. Exporting twice is a normal thing to
 * do, so a taken name is stepped past rather than overwritten: silently
 * replacing the previous file is data loss the user never asked for.
 */
function freeTablePath(vault: Vault, file: TFile | null, kind: "csv" | "md"): string {
  const folder = file?.parent?.path ?? "";
  const base = file?.basename ?? "table";
  const stem = normalizePath(`${folder}/${base}`);

  let path = `${stem}.${kind}`;
  let counter = 2;
  while (vault.getAbstractFileByPath(path)) {
    path = `${stem} ${counter}.${kind}`;
    counter += 1;
  }
  return path;
}
