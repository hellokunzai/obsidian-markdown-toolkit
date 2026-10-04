/**
 * The visual editor for a table that carries formulas.
 *
 * The shell, the title row, the toolbar and the dotted canvas are the diagram
 * editor's, class for class (`.mtk-modal-shell`, `.mtk-editor`, `.mtk-toolbar`,
 * `.mtk-tb`, `.mtk-canvas`, `.mtk-grid`) — a second editor in the same plugin
 * that looked like a second plugin would be the whole problem this reuse
 * avoids.
 *
 * What is new here is the shape of the thing being edited. A diagram is a
 * canvas; a table is a *grid*, and a grid has two properties a canvas does not:
 *
 * 1. **Cell addresses have to be visible.** `=sum(B2:B4)` is meaningless
 *    without a `B` over the column and a `2` beside the row, so the grid draws
 *    letter headers and number gutters. They are sticky, because a formula that
 *    scrolls away from its own coordinates is a formula you cannot check.
 * 2. **It fills the window.** A small table in the middle of a large editor
 *    looks like a loading state; the grid fills the canvas and keeps going with
 *    empty cells, which is also what says "you can put more here".
 *
 * Editing is done through the formula bar rather than in the cell. That is a
 * deliberate simplification with a real benefit: the bar always shows the cell's
 * *source* — `=sum(B2:B4)` — while the cell always shows its *value*. The two
 * never get confused, which is the one failure mode that would make the whole
 * feature untrustworthy.
 */
import { Menu, Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { h } from "../utils/dom";
import { tagModalCloseButton } from "../utils/modal-fullscreen";
import { applyTooltip } from "../utils/tooltip";
import {
  columnLetter,
  evaluateTable,
  type CellResult,
  type TableModel,
} from "../core/table-formula";
import type { TableFillMode } from "../settings";

export interface TableEditorRequest {
  app: App;
  model: TableModel;
  fillMode: TableFillMode;
  /** Called with the edited model when the user saves. */
  onSave: (model: TableModel) => void;
}

export function openTableEditor(request: TableEditorRequest): void {
  new TablePanel(request).open();
}

/** The aggregate functions the ƒ menu offers, in the order it lists them. */
const FUNCTIONS = ["sum", "avg", "count", "max", "min"] as const;

/** Row height and header height, in pixels. Kept here because the fill maths needs them. */
const ROW_HEIGHT = 34;
const HEAD_HEIGHT = 34;
const GUTTER_WIDTH = 42;
/** Column width when the grid is padding rather than stretching. */
const PAD_COLUMN = 132;
/** Below this, a stretched column stops being readable and the grid scrolls instead. */
const MIN_COLUMN = 96;

class TablePanel extends Modal {
  private readonly request: TableEditorRequest;
  /** A copy: cancelling must leave the note's table exactly as it was. */
  private model: TableModel;
  private results: CellResult[][];
  private selected = { row: 1, col: 0 };

  private canvasEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private refEl!: HTMLElement;
  private inputEl!: HTMLInputElement;

  constructor(request: TableEditorRequest) {
    super(request.app);
    this.request = request;
    this.model = {
      header: [...request.model.header],
      body: request.model.body.map((row) => [...row]),
      align: [...request.model.align],
    };
    this.results = evaluateTable(this.model);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("mtk-modal-shell");
    tagModalCloseButton(modalEl);
    contentEl.empty();

    const editor = h("div", { cls: "mtk-editor" });

    const header = h("div", { cls: "mtk-header" });
    header.appendChild(h("span", { cls: "mtk-title", text: t("settings.tab.table") }));
    header.appendChild(h("span", { cls: "mtk-mode", text: "table" }));
    editor.appendChild(header);

    this.toolbarEl = h("div", { cls: "mtk-toolbar" });
    editor.appendChild(this.toolbarEl);

    const bar = h("div", { cls: "mtk-fxbar" });
    this.refEl = h("span", { cls: "ref" });
    bar.appendChild(this.refEl);
    this.inputEl = h("input", { cls: "val", attr: { type: "text", spellcheck: "false" } }) as HTMLInputElement;
    /* Enter commits; so does leaving the field, because a value that is on
       screen and not yet in the model is the one thing this editor must not
       have. */
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitInput();
      }
    });
    this.inputEl.addEventListener("blur", () => this.commitInput());
    bar.appendChild(this.inputEl);
    editor.appendChild(bar);

    this.canvasEl = h("div", { cls: "mtk-canvas is-sheet" });
    this.canvasEl.appendChild(h("div", { cls: "mtk-grid" }));
    this.gridHost = h("div", { cls: "mtk-tbl-scroll" });
    this.canvasEl.appendChild(this.gridHost);
    editor.appendChild(this.canvasEl);

    contentEl.appendChild(editor);

    this.buildToolbar();
    this.renderGrid();
    this.syncBar();

    /* The first render happens before layout, so the canvas has no width and the
       grid cannot know how much to fill. One frame later it does. */
    window.requestAnimationFrame(() => this.renderGrid());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /* ------------------------------------------------------------- 工具条 */

  private buildToolbar(): void {
    this.toolbarEl.empty();

    const save = this.button("mtk-save", "save", t("editor.save"), () => {
      this.commitInput();
      this.request.onSave(this.model);
      this.close();
    });
    this.toolbarEl.appendChild(save);
    this.toolbarEl.appendChild(this.divider());

    this.toolbarEl.appendChild(
      this.button("", "rows", t("table.row.add"), () => {
        this.commitInput();
        this.model.body.push(this.model.header.map(() => ""));
        this.recompute();
      })
    );
    this.toolbarEl.appendChild(
      this.button("", "columns", t("table.col.add"), () => {
        this.commitInput();
        this.model.header.push("");
        this.model.body.forEach((row) => row.push(""));
        this.model.align.push("default");
        this.recompute();
      })
    );
    this.toolbarEl.appendChild(this.divider());

    /* The ƒ menu is an Obsidian `Menu` rather than a panel of our own: it is a
       list of commands, which is exactly what `Menu` is, and it arrives with
       the keyboard handling and the placement this would otherwise have to
       re-implement. */
    this.toolbarEl.appendChild(
      this.button("", "sigma", t("table.formula.insert"), (event: MouseEvent) => {
        const menu = new Menu();
        for (const name of FUNCTIONS) {
          menu.addItem((item) =>
            item
              .setTitle(name)
              .setIcon("sigma")
              .onClick(() => this.insertFormula(name))
          );
        }
        menu.showAtMouseEvent(event);
      })
    );
  }

  private button(
    extra: string,
    icon: string,
    label: string,
    onClick: (event: MouseEvent) => void
  ): HTMLButtonElement {
    const button = h("button", {
      cls: `mtk-tb${extra ? ` ${extra}` : ""} mtk-tb-icon-btn`,
      attr: { type: "button" },
    }) as HTMLButtonElement;
    const glyph = h("span", { cls: "mtk-tb-icon" });
    setIcon(glyph, icon);
    button.appendChild(glyph);
    button.addEventListener("click", onClick);
    applyTooltip(button, label);
    return button;
  }

  private divider(): HTMLElement {
    return h("div", { cls: "mtk-divider" });
  }

  /* --------------------------------------------------------------- 网格 */

  /**
   * How much grid to draw, given the room there is.
   *
   * The two modes differ only in where the spare width goes — extra columns, or
   * shared out among the ones that exist. Both have to end up covering the
   * canvas, because a grid that stops short leaves a grey band that reads as a
   * rendering fault.
   */
  private gridPlan(): { columnWidth: number; columns: number; rows: number } {
    const width = this.gridHost.clientWidth;
    const height = this.gridHost.clientHeight;
    const own = this.model.header.length;
    const stretch = this.request.fillMode === "stretch";

    // `ceil`, not `floor`: rounding down leaves the grid a few pixels short of
    // the canvas, which is precisely the band this is trying to avoid.
    const columnWidth = stretch
      ? Math.max(MIN_COLUMN, Math.ceil((width - GUTTER_WIDTH) / Math.max(1, own)))
      : PAD_COLUMN;
    const columns = stretch
      ? Math.max(1, own)
      : Math.max(own, Math.ceil((width - GUTTER_WIDTH) / PAD_COLUMN));
    const rows = Math.max(
      this.model.body.length + 1,
      Math.ceil((height - HEAD_HEIGHT) / ROW_HEIGHT)
    );
    return { columnWidth, columns, rows };
  }

  private renderGrid(): void {
    this.gridHost.empty();
    const plan = this.gridPlan();

    const grid = h("div", { cls: "mtk-tbl-sheet" });

    const headRow = h("div", { cls: "mtk-sheet-row is-head" });
    headRow.appendChild(h("div", { cls: "mtk-sheet-cell mtk-sheet-gutter" }));
    for (let col = 0; col < plan.columns; col += 1) {
      const cell = h("div", {
        cls: "mtk-sheet-cell" + (col >= this.model.header.length ? " is-filler" : ""),
        text: columnLetter(col),
      });
      cell.style.width = `${plan.columnWidth}px`;
      headRow.appendChild(cell);
    }
    grid.appendChild(headRow);

    for (let row = 0; row < plan.rows; row += 1) {
      grid.appendChild(this.buildRow(row, plan.columnWidth, plan.columns));
    }

    this.gridHost.appendChild(grid);
  }

  private buildRow(row: number, columnWidth: number, columns: number): HTMLElement {
    const tr = h("div", { cls: "mtk-sheet-row" });
    tr.appendChild(h("div", { cls: "mtk-sheet-cell mtk-sheet-gutter", text: String(row + 1) }));

    const values = row === 0 ? this.model.header : this.model.body[row - 1];

    for (let col = 0; col < columns; col += 1) {
      const cell = h("div", { cls: "mtk-sheet-cell" });
      cell.style.width = `${columnWidth}px`;

      /* Past the table's own columns the grid keeps going. Those cells exist to
         fill the canvas and are inert — which is also why the check is on the
         column count first: in pad mode the *header* row runs past the table's
         columns too, and those are just as much filler as the ones below. */
      const beyondColumns = col >= this.model.header.length;
      if (beyondColumns || (row >= 1 && values === undefined)) {
        cell.classList.add("is-filler");
        tr.appendChild(cell);
        continue;
      }

      const result = this.results[row]?.[col];
      if (result) {
        cell.textContent = result.text;
        if (row > 0 && this.numericColumn(col)) cell.classList.add("is-num");
        if (result.error) cell.classList.add("is-err");
        if (result.formula) cell.classList.add("is-fx");
      }
      if (row === this.selected.row && col === this.selected.col) {
        cell.classList.add("is-selected");
      }

      /* An IIFE, and not a nicety: `row`/`col` are `var`-like loop bindings, so
         a listener that closed over them directly would send every cell to the
         last one drawn. */
      cell.addEventListener("click", () => this.select(row, col));
      tr.appendChild(cell);
    }
    return tr;
  }

  private numericColumn(col: number): boolean {
    return this.results.slice(1).some((row) => typeof row[col]?.num === "number");
  }

  /* ------------------------------------------------------------- 编辑 */

  private select(row: number, col: number): void {
    this.commitInput();
    this.selected = { row, col };
    this.renderGrid();
    this.syncBar();
  }

  /** Puts the selected cell's *source* in the formula bar, not its value. */
  private syncBar(): void {
    const { row, col } = this.selected;
    this.refEl.textContent = columnLetter(col) + (row + 1);
    const raw = row === 0 ? this.model.header[col] ?? "" : this.model.body[row - 1]?.[col] ?? "";
    this.inputEl.value = raw;
  }

  private commitInput(): void {
    const { row, col } = this.selected;
    const value = this.inputEl.value.trim();
    const current = row === 0 ? this.model.header[col] ?? "" : this.model.body[row - 1]?.[col] ?? "";
    if (value === current) return;

    if (row === 0) this.model.header[col] = value;
    else {
      const target = this.model.body[row - 1];
      if (target) target[col] = value;
    }
    this.recompute();
  }

  /**
   * Writes `=fn(col<from>:col<to>)` into the selected cell.
   *
   * The range is the run of numbers directly above the cell, which is what a
   * spreadsheet's "sum above" does. Its limit is worth stating plainly: it can
   * tell a number from a word, and it **cannot** tell a data row from a totals
   * row, because both are numbers. So the cell this is aimed at is a totals
   * row — putting it under a totals row would double-count, and there is nothing
   * here that could know better.
   */
  private insertFormula(name: string): void {
    const { row, col } = this.selected;
    if (row === 0) return;

    this.commitInput();
    const letter = columnLetter(col);
    const [from, to] = this.rangeAbove(row, col);
    const target = this.model.body[row - 1];
    if (!target) return;
    target[col] = `=${name}(${letter}${from}:${letter}${to})`;
    this.recompute();
  }

  /** The contiguous run of numeric cells above `row`, as A1 row numbers. */
  private rangeAbove(row: number, col: number): [number, number] {
    let top = row - 1;
    while (top >= 1 && typeof this.results[top]?.[col]?.num === "number") top -= 1;
    if (top + 1 >= row) return [2, Math.max(2, row)];
    return [top + 2, row];
  }

  private recompute(): void {
    this.results = evaluateTable(this.model);
    this.renderGrid();
    this.syncBar();
  }
}
