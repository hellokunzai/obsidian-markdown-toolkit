/**
 * The parts of a framed table that both renderers need.
 *
 * A table is shown in two places — the reading view, where Obsidian hands over
 * finished elements, and Live Preview, where CodeMirror owns the DOM — and the
 * two differ in everything except what a table *looks like when it is framed*.
 * So the frame lives here once, and each renderer's job is only to find a table
 * and to say how an edit gets written back.
 *
 * The bug this file was extracted to fix, because it is the one that is invisible
 * from the code that caused it: the frame used to be inserted *beside* the
 * renderer's table rather than around it, so in "drawn" mode the note showed
 * two tables — the painted one inside the frame and the original still sitting
 * below it. Adopting the native element is not a detail of one render mode; it
 * is what makes the other modes possible at all.
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { h } from "../utils/dom";
import { applyTooltip } from "../utils/tooltip";
import {
  countFormulas,
  serializeTable,
  type CellResult,
  type TableAlign,
  type TableModel,
} from "../core/table-formula";
import type { TableRenderMode, TableTarget } from "../settings";

/** True when any cell in a rendered table holds a formula. */
export function looksComputed(table: HTMLElement): boolean {
  for (const cell of Array.from(table.querySelectorAll("td"))) {
    if ((cell.textContent ?? "").trim().startsWith("=")) return true;
  }
  return false;
}

/**
 * Whether this table is one the plugin should frame.
 *
 * `"computed"` leaves every table without a formula exactly as the renderer
 * drew it, which keeps the plugin invisible in a vault that does not use
 * formulas at all. `"all"` frames every table, which is what "render the table"
 * means when the table is the thing being styled rather than the formulas in
 * it — and it is the default, because a table with no formulas in it is still a
 * table worth framing.
 */
export function shouldFrame(table: HTMLElement, target: TableTarget): boolean {
  return target === "all" || looksComputed(table);
}

/**
 * A rendered table read back into a model.
 *
 * The header is the first row whether or not it is marked up with `th`: a table
 * Markdown would not render is not a table, so the first row is always the
 * header and everything below it is data.
 */
export function modelFromTable(table: HTMLElement): TableModel {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.querySelectorAll("th, td")).map((cell) =>
      (cell.textContent ?? "").trim()
    );
    if (cells.length > 0) rows.push(cells);
  }

  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const align = header.map((_unused, i) => alignFromCell(table, i, body.length > 0 ? 1 : 0));
  return { header, body, align };
}

/**
 * A column's alignment, read off the cell the renderer wrote it to.
 *
 * The `| :--: |` row never reaches the DOM — the renderer turns it into an
 * inline `text-align` on the cells — so this is the only place left to learn it
 * from.
 */
function alignFromCell(table: HTMLElement, col: number, row: number): TableAlign {
  const tr = table.querySelectorAll("tr")[row];
  const cell = tr?.querySelectorAll("th, td")[col] as HTMLElement | undefined;
  if (!cell) return "default";
  const value = cell.style.textAlign || window.getComputedStyle(cell).textAlign;
  if (value === "center") return "center";
  if (value === "right") return "right";
  if (value === "left") return "left";
  return "default";
}

/** True when a column resolved to numbers, which is what right-aligns it. */
function numericColumn(results: CellResult[][], col: number): boolean {
  return results.slice(1).some((row) => typeof row[col]?.num === "number");
}

/**
 * The table this plugin paints.
 *
 * Wrapped in its own bordered box rather than left to carry borders cell by
 * cell: a `border-collapse` table with per-cell rules gets a doubled outer edge
 * against the frame's own background, which is what made the first version look
 * like a spreadsheet screenshot pasted into the note.
 */
export function paintTable(model: TableModel, results: CellResult[][]): HTMLElement {
  const wrap = h("div", { cls: "mtk-tbl-wrap" });
  const table = h("table", { cls: "mtk-tbl" });

  const head = h("thead");
  const headRow = h("tr");
  model.header.forEach((text, col) => {
    const th = h("th", { text });
    if (numericColumn(results, col)) th.classList.add("is-num");
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = h("tbody");
  results.slice(1).forEach((row) => {
    const tr = h("tr");
    if (row.some((cell) => cell.formula)) tr.classList.add("mtk-calc");
    row.forEach((cell, col) => {
      const td = h("td");
      if (numericColumn(results, col)) td.classList.add("is-num");
      if (cell.error) td.classList.add("is-err");
      if (cell.formula) {
        td.classList.add("mtk-fx");
        /* The marker is an inline span rather than a `::after` pinned to the
           corner. At a table's density the corner sits on top of the number it
           belongs to, and a figure with a glyph through it reads as a rendering
           fault — which is exactly what it looked like. */
        td.appendChild(h("span", { cls: "mtk-fx-mark", text: "ƒ" }));
        applyTooltip(td, cell.raw);
      }
      td.appendChild(document.createTextNode(cell.text));
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);

  wrap.appendChild(table);
  return wrap;
}

export interface TableFrameOptions {
  model: TableModel;
  results: CellResult[][];
  /** How the framed table is drawn. */
  mode: TableRenderMode;
  /** The element the renderer produced, adopted so the other modes can hide it. */
  native: HTMLElement;
  onEdit: () => void;
}

export interface TableFrame {
  readonly el: HTMLElement;
  /** Re-renders in place with a fresh model; used when the note changes underneath. */
  update(model: TableModel, results: CellResult[][]): void;
  /**
   * Puts every cell this frame overwrote back the way the renderer wrote it.
   *
   * Only the Live Preview needs this, and it needs it badly: there the cells
   * are the editor, so a cell left holding `15` when the note says `=B2*C2` is
   * a cell that lies about what you are about to edit.
   */
  restore(): void;
}

/**
 * Cell text as the renderer wrote it, before this plugin replaced it.
 *
 * Keyed by the cell element and held at module scope rather than inside a
 * frame, because frames get rebuilt: a per-frame cache would be repopulated
 * from cells that had *already* been overwritten, and the second cache would
 * record `15` as the original text.
 */
const originalText = new WeakMap<HTMLElement, string>();

/** Undoes `writeValuesInto` for a table, and forgets what it had cached. */
export function restoreNativeText(table: HTMLElement): void {
  for (const cell of Array.from(table.querySelectorAll<HTMLElement>("th, td"))) {
    const raw = originalText.get(cell);
    if (raw === undefined) continue;
    cell.textContent = raw;
    cell.classList.remove("mtk-cell-computed", "mtk-cell-error");
    originalText.delete(cell);
  }
}

/**
 * A framed table, ready to be placed where the note's table was.
 *
 * `mode` decides which of the three things goes inside the frame: the renderer's
 * own table with the answers written into it, the table this plugin paints, or
 * the note's Markdown. The native element is adopted in every one of them
 * because a table that is merely *hidden* by CSS is one stylesheet away from
 * being visible again, and one that is not in the tree at all cannot be
 * half-visible.
 */
export function buildTableFrame(options: TableFrameOptions): TableFrame {
  let model = options.model;
  let results = options.results;
  let mode = options.mode;
  let showingSource = false;

  const box = h("div", { cls: "mtk-embed" });
  const body = h("div", { cls: "mtk-embed-table" });
  box.appendChild(body);

  const badge = h("div", { cls: "mtk-embed-meta" });
  const badgeText = h("span");
  badge.appendChild(badgeText);
  box.appendChild(badge);

  const edit = h("button", { cls: "mtk-embed-action mtk-embed-edit", attr: { type: "button" } });
  setIcon(edit, "square-pen");
  applyTooltip(edit, t("table.edit"));
  edit.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    options.onEdit();
  });
  box.appendChild(edit);

  const source = h("button", { cls: "mtk-embed-action mtk-embed-code", attr: { type: "button" } });
  setIcon(source, "code");
  applyTooltip(source, t("table.source"));
  source.addEventListener("click", (event: MouseEvent) => {
    event.stopPropagation();
    showingSource = !showingSource;
    render();
  });
  box.appendChild(source);

  /** Writes the computed text into the cells the renderer already drew. */
  const writeValuesInto = (table: HTMLElement): void => {
    const rows = Array.from(table.querySelectorAll("tr"));
    rows.forEach((tr, r) => {
      Array.from(tr.querySelectorAll<HTMLElement>("th, td")).forEach((cell, col) => {
        const result = results[r]?.[col];
        if (!result || !result.formula) return;
        // Cached before the first overwrite, and only then: `restore()` clears
        // the entry, so coming back to this table re-reads what is there now.
        if (!originalText.has(cell)) originalText.set(cell, cell.textContent ?? "");
        if (cell.textContent !== result.text) cell.textContent = result.text;
        cell.classList.add("mtk-cell-computed");
        if (result.error) cell.classList.add("mtk-cell-error");
        applyTooltip(cell, result.raw);
      });
    });
  };

  const render = (): void => {
    body.empty();
    if (showingSource) {
      body.appendChild(h("pre", { cls: "mtk-tbl-source", text: serializeTable(model) }));
    } else if (mode === "native") {
      writeValuesInto(options.native);
      options.native.classList.add("mtk-cell-native");
      body.appendChild(options.native);
    } else {
      body.appendChild(paintTable(model, results));
    }

    /* The formula count is dropped rather than shown as zero: the badge is
       there to say what the frame is holding, and "0 formulas" is a line about
       nothing. */
    const formulas = countFormulas(model);
    badgeText.textContent = formulas > 0
      ? t("table.badge", { rows: model.body.length, cols: model.header.length, formulas })
      : t("table.badgePlain", { rows: model.body.length, cols: model.header.length });
  };

  render();

  return {
    el: box,
    update(nextModel: TableModel, nextResults: CellResult[][]): void {
      model = nextModel;
      results = nextResults;
      render();
    },
    restore(): void {
      restoreNativeText(options.native);
    },
  };
}
