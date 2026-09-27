/**
 * Writing an exported drawing to disk, beside the note it came from.
 *
 * Two entry points export the same thing — the editor's toolbar and the
 * reading view's block/preview — and they must agree on three things that are
 * easy to get subtly different: where the file lands, what it is called when
 * that name is taken, and what the user is told. So the whole sequence lives
 * here once and both callers hand over a finished document.
 *
 * The folder is taken from the note rather than from a setting: an export is a
 * sibling of its note, and a drawing that lands in a fixed folder loses the one
 * piece of context that says which note it belongs to.
 */
import { Notice, normalizePath, type App, type TFile, type Vault } from "obsidian";
import { t } from "../i18n";
import { rasterizeSvg } from "../render/export";

/** The two formats the exports offer. */
export type ExportKind = "svg" | "png";

/** A standalone document plus the pixel size its rasteriser needs. */
export interface DrawingFile {
  svg: string;
  width: number;
  height: number;
}

/**
 * Writes the document next to `note` and says where it went.
 *
 * Failures are reported rather than thrown: the caller is a click handler on a
 * button in a note, and a rejected promise there is an unhandled rejection in
 * the console rather than anything the user can act on.
 */
export async function writeDrawingFile(
  app: App,
  note: TFile | null,
  kind: ExportKind,
  drawing: DrawingFile
): Promise<void> {
  const path = freePath(app.vault, note, kind);
  try {
    if (kind === "svg") await app.vault.create(path, drawing.svg);
    else await app.vault.createBinary(path, await rasterizeSvg(drawing.svg, drawing.width, drawing.height, 2));
    new Notice(t("notice.exported", { name: path }));
  } catch (error) {
    console.error("MarkdownEditorPlus: export failed", error);
    new Notice(t("notice.exportFailed"));
  }
}

/**
 * `note`'s folder plus its basename, never taken twice.
 *
 * The root folder's `path` is `/`, not the empty string, so the two are joined
 * through `normalizePath` — otherwise a note at the vault root exports to
 * `//note.svg` and the confirmation reads like a typo. `normalizePath` collapses
 * the doubled separator and keeps a nested folder intact ("dir/note"), which
 * makes it the one place that has to know about the root's spelling.
 *
 * Exporting twice is a normal thing to do, so a taken name is stepped past
 * rather than overwritten: silently replacing the previous file is data loss
 * the user never asked for.
 */
function freePath(vault: Vault, note: TFile | null, kind: ExportKind): string {
  const folder = note?.parent?.path ?? "";
  const base = note?.basename ?? "diagram";
  const stem = normalizePath(`${folder}/${base}`);

  let path = `${stem}.${kind}`;
  let counter = 2;
  while (vault.getAbstractFileByPath(path)) {
    path = `${stem} ${counter}.${kind}`;
    counter += 1;
  }
  return path;
}
