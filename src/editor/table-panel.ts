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
 * A grid that only answers clicks on one cell at a time is a grid people give
 * up on, so the interaction layer is deliberately spreadsheet-shaped: drag or
 * Shift to select a range, arrows and Tab to move, double-click to type in the
 * cell, drag the fill handle to continue a series, Del to clear, Ctrl+C/V to
 * move blocks through the clipboard, and — the one that makes the empty cells
 * honest — clicking past the table's edge grows it rather than doing nothing.
 *
 * The headers carry the other half of the bargain. A column letter's right edge
 * and a row number's bottom edge are draggable, because a grid whose column is
 * too narrow for its own contents is a grid you stop using; and either header
 * answers a right-click with the three things you can do to a whole column or
 * row, because "delete this column" should not require counting columns. Sizes
 * dragged this way belong to the dialog and are not written back: Markdown has
 * nowhere to put a column width, and a note that carried one would be a note
 * nothing else could read.
 *
 * The formula bar still shows the selected cell's *source* — `=sum(B2:B4)` —
 * while the cell shows its *value*. That split is preserved on purpose: it is
 * the one place the two can be told apart, and it is why typing in the bar is
 * never ambiguous.
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

/*
 * How far a dragged column edge or row edge may travel, in pixels. The floor is
 * "the content is still legible", the ceiling is only there so a slip of the
 * hand cannot fling one row off the screen — neither is a spreadsheet rule, and
 * both are meant to be argued with.
 */
const MIN_COL_W = 48;
const MAX_COL_W = 800;
const MIN_ROW_H = 20;
const MAX_ROW_H = 400;

const clamp = (value: number, low: number, high: number): number =>
  Math.round(Math.max(low, Math.min(high, value)));

/**
 * How many units of `size(i)`, after a leading `lead`, fit inside `limit`.
 *
 * This is the `Math.ceil((limit - lead) / CONSTANT)` it replaced, for the case
 * where the units are no longer all the same size. With every size equal the
 * walk below lands on exactly the same count, so an untouched table draws the
 * same grid it always did; once a column has been dragged, "how many columns to
 * cover the canvas" is a walk and not a division.
 */
function fitAcross(limit: number, lead: number, size: (index: number) => number): number {
  let count = 0;
  let used = lead;
  while (used < limit) {
    used += size(count);
    count += 1;
  }
  return count;
}

/** A zero-based grid cell. Row 0 is the header; col 0 is column A. */
interface Cell {
  row: number;
  col: number;
}

/** A rectangular selection, normalised so `r1 <= r2` and `c1 <= c2`. */
interface Box {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** What a pointer gesture is doing, held for the life of one press. */
type Drag =
  | { mode: "cells" }
  | { mode: "cols"; start: number }
  | { mode: "rows"; start: number }
  | { mode: "fill"; from: Box }
  /* A size drag keeps the size the press started from, not the size as it is
     now: every move re-renders the grid, so measuring "the current width" each
     time would compound whatever the last render rounded to. */
  | { mode: "colw"; col: number; startX: number; startW: number }
  | { mode: "rowh"; row: number; startY: number; startH: number };

/** What a sheet cell is: a data cell, a column letter, or a row number. */
interface Hit {
  head: "col" | "row" | null;
  row: number;
  col: number;
  filler: boolean;
}

class TablePanel extends Modal {
  private readonly request: TableEditorRequest;
  /** A copy: cancelling must leave the note's table exactly as it was. */
  private model: TableModel;
  private results: CellResult[][];

  /** The fixed corner a Shift-extended selection grows from. */
  private anchor: Cell = { row: 1, col: 0 };
  /** The moving cell: what the formula bar, headers and keyboard act on. */
  private active: Cell = { row: 1, col: 0 };
  private range: Box = { r1: 1, c1: 0, r2: 1, c2: 0 };
  private editing: Cell | null = null;
  private drag: Drag | null = null;

  /*
   * Sizes the user dragged. Sparse on purpose: anything absent falls back to the
   * default, so a table nobody has resized renders exactly as it did before
   * this existed. Both live for the life of the dialog and are never written
   * back to the note — a table's Markdown has nowhere to put a column width,
   * and inventing one would make the note unreadable in every other editor.
   */
  private readonly colW: Record<number, number | undefined> = {};
  private readonly rowH: Record<number, number | undefined> = {};
  /** The width a column gets when it has not been dragged: padded or stretched. */
  private baseColumnWidth = PAD_COLUMN;

  private canvasEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private sheetEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private refBox!: HTMLElement;
  private refLabel!: HTMLElement;
  private fxBtn!: HTMLButtonElement;
  private inputEl!: HTMLInputElement;
  private cellInput!: HTMLInputElement;
  private rangeBox!: HTMLElement;
  private fillHandle!: HTMLElement;

  /** Unsubscribe callbacks for the document-level listeners, run on close. */
  private readonly teardown: Array<() => void> = [];

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
    this.teardown.length = 0;

    const editor = h("div", { cls: "mtk-editor" });

    const header = h("div", { cls: "mtk-header" });
    header.appendChild(h("span", { cls: "mtk-title", text: t("settings.tab.table") }));
    header.appendChild(h("span", { cls: "mtk-mode", text: "table" }));
    editor.appendChild(header);

    this.toolbarEl = h("div", { cls: "mtk-toolbar" });
    editor.appendChild(this.toolbarEl);

    const bar = h("div", { cls: "mtk-fxbar" });

    /* The name box: a clickable cell address that opens a dropdown of every cell
       in the table, so you can jump straight to one without hunting by hand. */
    this.refBox = h("div", { cls: "mtk-ref-box" });
    this.refLabel = h("span", { cls: "ref" });
    this.refBox.appendChild(this.refLabel);
    this.refBox.appendChild(h("span", { cls: "mtk-ref-caret", text: "⌄" }));
    applyTooltip(this.refBox, t("table.nameBox"));
    this.refBox.addEventListener("click", (event: MouseEvent) => this.openRefMenu(event));
    bar.appendChild(this.refBox);

    /* The edit group: an ƒ button that opens the aggregate-function menu on the
       left, and the source field on the right. This is where the toolbar's old σ
       lived — moved here so there is a single, spreadsheet-shaped place to start a
       formula. */
    const group = h("div", { cls: "mtk-fx-group" });
    this.fxBtn = h("button", { cls: "mtk-fx-btn", attr: { type: "button" } }) as HTMLButtonElement;
    this.fxBtn.textContent = "fx";
    applyTooltip(this.fxBtn, t("table.formula.insert"));
    this.fxBtn.addEventListener("click", (event: MouseEvent) => this.openFxMenu(event));
    group.appendChild(this.fxBtn);
    group.appendChild(h("span", { cls: "mtk-fx-sep" }));

    this.inputEl = h("input", {
      cls: "val",
      attr: { type: "text", spellcheck: "false" },
    }) as HTMLInputElement;
    /* Enter commits and steps down, Tab commits and steps across, Escape puts
       the source back — the same keys the cell editor uses, so the bar is not
       a second, differently-behaved way to type the same thing. */
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitInput();
        this.moveTo(this.active.row + 1, this.active.col, false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.commitInput();
        this.moveTo(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.syncBar();
        this.inputEl.blur();
      }
    });
    this.inputEl.addEventListener("blur", () => this.commitInput());
    group.appendChild(this.inputEl);
    bar.appendChild(group);
    editor.appendChild(bar);

    this.canvasEl = h("div", { cls: "mtk-canvas is-sheet" });
    this.canvasEl.appendChild(h("div", { cls: "mtk-grid" }));
    this.gridHost = h("div", { cls: "mtk-tbl-scroll" });
    this.canvasEl.appendChild(this.gridHost);
    editor.appendChild(this.canvasEl);

    contentEl.appendChild(editor);

    this.buildToolbar();
    this.wirePointer();
    this.wireKeyboard();
    this.renderGrid();

    /* The first render happens before layout, so the canvas has no width and the
       grid cannot know how much to fill. One frame later it does. */
    window.requestAnimationFrame(() => this.renderGrid());
  }

  onClose(): void {
    for (const off of this.teardown) off();
    this.teardown.length = 0;
    this.contentEl.empty();
  }

  /** `addEventListener` that is undone on close. `Modal` is not a `Component`,
      so Obsidian's `registerDomEvent` is not available here. */
  private listen<T extends Event>(target: EventTarget, type: string, handler: (event: T) => void): void {
    const wrapped = (event: Event): void => handler(event as T);
    target.addEventListener(type, wrapped);
    this.teardown.push(() => target.removeEventListener(type, wrapped));
  }

  /* ------------------------------------------------------------- 工具条 */

  private buildToolbar(): void {
    this.toolbarEl.empty();

    this.toolbarEl.appendChild(
      this.button("mtk-save", "save", t("editor.save"), () => {
        this.commitInput();
        this.request.onSave(this.model);
        this.close();
      })
    );
    this.toolbarEl.appendChild(this.divider());

    this.toolbarEl.appendChild(this.button("", "rows", t("table.row.add"), () => this.addRow()));
    this.toolbarEl.appendChild(this.button("", "columns", t("table.col.add"), () => this.addColumn()));
    this.toolbarEl.appendChild(this.divider());
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

  private addRow(): void {
    this.commitInput();
    this.model.body.push(this.model.header.map(() => ""));
    this.recompute();
  }

  private addColumn(): void {
    this.commitInput();
    this.model.header.push("");
    this.model.body.forEach((row) => row.push(""));
    this.model.align.push("default");
    this.recompute();
  }

  /*
   * The six actions the header menu offers.
   *
   * Each one leaves the selection on the thing it just made, or on the nearest
   * surviving neighbour of the thing it just removed. Nothing here is undoable,
   * so the selection is the only signal of what actually happened — which is
   * also why these do not share a body with the toolbar's `add*`: the toolbar
   * buttons were already there and did not move the selection, and quietly
   * changing that would be a second change wearing the first one's clothes.
   */

  private insertColumnBefore(col: number): void {
    this.commitInput();
    this.model.header.splice(col, 0, "");
    this.model.body.forEach((cells) => cells.splice(col, 0, ""));
    this.model.align.splice(col, 0, "default");
    this.recompute();
    this.selectCell(1, col);
  }

  private deleteColumn(col: number): void {
    if (this.model.header.length <= 1) return;
    this.commitInput();
    this.model.header.splice(col, 1);
    this.model.body.forEach((cells) => cells.splice(col, 1));
    this.model.align.splice(col, 1);
    this.recompute();
    this.selectCell(this.active.row, Math.min(col, this.model.header.length - 1));
  }

  private appendColumn(): void {
    this.commitInput();
    this.model.header.push("");
    this.model.body.forEach((cells) => cells.push(""));
    this.model.align.push("default");
    this.recompute();
    this.selectCell(1, this.model.header.length - 1);
  }

  private insertRowBefore(row: number): void {
    this.commitInput();
    /* Row 1 is the header row and has nothing above it, so "above row 1" lands
       at the top of the data area — which is still immediately under the
       header, and the only reading that can actually be carried out. */
    const at = row === 0 ? 0 : row - 1;
    this.model.body.splice(at, 0, this.model.header.map(() => ""));
    this.recompute();
    this.selectCell(at + 1, this.active.col);
  }

  private deleteRow(row: number): void {
    if (row === 0) return;
    this.commitInput();
    this.model.body.splice(row - 1, 1);
    this.recompute();
    this.selectCell(Math.max(1, Math.min(row, this.model.body.length)), this.active.col);
  }

  private appendRow(): void {
    this.commitInput();
    this.model.body.push(this.model.header.map(() => ""));
    this.recompute();
    this.selectCell(this.model.body.length, this.active.col);
  }

  /* --------------------------------------------------------------- 网格 */

  /**
   * How much grid to draw, given the room there is.
   *
   * The two modes differ only in where the spare width goes — extra columns, or
   * shared out among the ones that exist. Both have to end up covering the
   * canvas, because a grid that stops short leaves a grey band that reads as a
   * rendering fault.
   *
   * Both axes count against the sizes actually in force, not against the
   * defaults: widening a column means fewer of them fit, and a row pulled tall
   * means fewer rows are visible. Counting the defaults would leave the grid
   * short of the canvas on one side of the drag and overflowing it on the other.
   */
  private gridPlan(): { columns: number; rows: number } {
    const width = this.gridHost.clientWidth;
    const height = this.gridHost.clientHeight;
    const own = this.model.header.length;

    // `ceil`, not `floor`: rounding down leaves the grid a few pixels short of
    // the canvas, which is precisely the band this is trying to avoid.
    this.baseColumnWidth =
      this.request.fillMode === "stretch"
        ? Math.max(MIN_COLUMN, Math.ceil((width - GUTTER_WIDTH) / Math.max(1, own)))
        : PAD_COLUMN;

    return {
      columns: Math.max(own, fitAcross(width, GUTTER_WIDTH, (col) => this.colWidth(col))),
      rows: Math.max(
        this.model.body.length + 1,
        fitAcross(height, HEAD_HEIGHT, (row) => this.rowHeight(row))
      ),
    };
  }

  /** The width a column gets when it has not been dragged. */
  private colWidth(col: number): number {
    return this.colW[col] ?? this.baseColumnWidth;
  }

  /** The height a row gets when it has not been dragged. */
  private rowHeight(row: number): number {
    return this.rowH[row] ?? ROW_HEIGHT;
  }

  private setColWidth(col: number, width: number): void {
    this.colW[col] = clamp(width, MIN_COL_W, MAX_COL_W);
    this.renderGrid();
  }

  private setRowHeight(row: number, height: number): void {
    this.rowH[row] = clamp(height, MIN_ROW_H, MAX_ROW_H);
    this.renderGrid();
  }

  /**
   * The draggable edge of a column or a row.
   *
   * It sits *inside* the header cell or row number rather than straddling the
   * border, because those cells clip: a hotspot hanging half outside would be
   * sliced in half, and the missing half is invisible on screen — it shows up
   * only as "sometimes the edge will not grab".
   */
  private resizer(kind: "col" | "row", index: number): HTMLElement {
    return h("div", {
      cls: kind === "col" ? "mtk-col-resizer" : "mtk-row-resizer",
      attr:
        kind === "col"
          ? { "data-resize": "col", "data-c": String(index) }
          : { "data-resize": "row", "data-r": String(index) },
    });
  }

  /**
   * Row height goes on each cell, not on the row: the cells carry a fixed
   * height of their own, so a row-level rule loses to them — and writing it per
   * cell also means the size still applies against a stylesheet that has not
   * caught up yet.
   */
  private applyRowHeight(el: HTMLElement, row: number): void {
    const height = `${this.rowHeight(row)}px`;
    el.style.height = height;
    el.style.lineHeight = height;
  }

  private renderGrid(): void {
    this.gridHost.empty();
    const plan = this.gridPlan();

    const sheet = h("div", { cls: "mtk-tbl-sheet" });
    this.sheetEl = sheet;

    const headRow = h("div", { cls: "mtk-sheet-row is-head" });
    headRow.appendChild(h("div", { cls: "mtk-sheet-cell mtk-sheet-gutter" }));
    for (let col = 0; col < plan.columns; col += 1) {
      const filler = col >= this.model.header.length;
      const cell = h("div", {
        cls: "mtk-sheet-cell" + (filler ? " is-filler" : ""),
        text: columnLetter(col),
        attr: { "data-head": "col", "data-hcol": String(col) },
      });
      cell.style.width = `${this.colWidth(col)}px`;
      /* Every column edge is draggable, the filler ones included: a size is a
         thing that lives in this dialog and nowhere else, so a column added to
         cover the canvas can carry one just as honestly as a real column. It is
         the difference between "the grid keeps going" and "why won't this edge
         grab", which is the kind of gap you only find by trying it. */
      cell.appendChild(this.resizer("col", col));
      headRow.appendChild(cell);
    }
    sheet.appendChild(headRow);

    for (let row = 0; row < plan.rows; row += 1) {
      sheet.appendChild(this.buildRow(row, plan.columns));
    }

    /* The selection rectangle and the cell editor are drawn inside the sheet so
       they scroll with it, which is also why the sheet is the positioned box. */
    this.rangeBox = h("div", { cls: "mtk-range-box" });
    this.fillHandle = h("div", { cls: "mtk-fill-handle" });
    applyTooltip(this.fillHandle, t("table.fillHandle"));
    this.rangeBox.appendChild(this.fillHandle);
    sheet.appendChild(this.rangeBox);

    this.cellInput = h("input", {
      cls: "mtk-cell-input",
      attr: { type: "text", spellcheck: "false" },
    }) as HTMLInputElement;
    this.wireCellInput();
    sheet.appendChild(this.cellInput);

    this.gridHost.appendChild(sheet);
    this.refreshSelection();
  }

  private buildRow(row: number, columns: number): HTMLElement {
    const tr = h("div", { cls: "mtk-sheet-row" });
    /* A row number is filler under exactly the boundary its data cells use, so
       "the number below the table" and "the cell below the table" are one
       gesture rather than two that almost agree. Which of them a click grew the
       table was, for a while, a difference the code could not tell apart: the
       number never carried the class, so the branch that adds a row was dead. */
    const gutter = h("div", {
      cls:
        "mtk-sheet-cell mtk-sheet-gutter" +
        (row > this.model.body.length ? " is-filler" : ""),
      text: String(row + 1),
      attr: { "data-head": "row", "data-hrow": String(row) },
    });
    this.applyRowHeight(gutter, row);
    gutter.appendChild(this.resizer("row", row));
    tr.appendChild(gutter);

    const values = row === 0 ? this.model.header : this.model.body[row - 1];

    for (let col = 0; col < columns; col += 1) {
      const cell = h("div", {
        cls: "mtk-sheet-cell",
        attr: { "data-row": String(row), "data-col": String(col) },
      });
      cell.style.width = `${this.colWidth(col)}px`;
      this.applyRowHeight(cell, row);

      /* Past the table's own columns the grid keeps going. Those cells exist to
         fill the canvas — but they are not inert any more: clicking one grows
         the table to include it (see `extendTo`), which is what makes the empty
         space an invitation rather than a dead zone. */
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
      tr.appendChild(cell);
    }
    return tr;
  }

  private numericColumn(col: number): boolean {
    return this.results.slice(1).some((row) => typeof row[col]?.num === "number");
  }

  /** The rendered data cell at `row`/`col`, for measuring the overlay against. */
  private cellEl(row: number, col: number): HTMLElement | null {
    return this.sheetEl.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  }

  private inRange(row: number, col: number): boolean {
    return row >= this.range.r1 && row <= this.range.r2 && col >= this.range.c1 && col <= this.range.c2;
  }

  /** Repaints selection-dependent classes and re-places the overlay. Cheap:
      selection never changes the grid's shape, only how it is drawn. */
  private refreshSelection(): void {
    this.sheetEl.querySelectorAll<HTMLElement>(".mtk-sheet-cell[data-row]").forEach((cell) => {
      const row = Number(cell.getAttribute("data-row"));
      const col = Number(cell.getAttribute("data-col"));
      cell.classList.toggle("in-range", this.inRange(row, col));
      cell.classList.toggle("is-selected", row === this.active.row && col === this.active.col);
    });
    this.sheetEl.querySelectorAll<HTMLElement>('[data-head="col"]').forEach((cell) => {
      cell.classList.toggle("is-hl", Number(cell.getAttribute("data-hcol")) === this.active.col);
    });
    this.sheetEl.querySelectorAll<HTMLElement>('[data-head="row"]').forEach((cell) => {
      cell.classList.toggle("is-hl", Number(cell.getAttribute("data-hrow")) === this.active.row);
    });
    this.positionOverlay();
    this.syncBar();
  }

  private positionOverlay(): void {
    const first = this.cellEl(this.range.r1, this.range.c1);
    const last = this.cellEl(this.range.r2, this.range.c2);
    const showBox = Boolean(first && last) && !this.editing;
    this.rangeBox.classList.toggle("is-on", showBox);
    if (showBox && first && last) {
      this.rangeBox.style.left = `${first.offsetLeft - 1}px`;
      this.rangeBox.style.top = `${first.offsetTop - 1}px`;
      this.rangeBox.style.width = `${last.offsetLeft + last.offsetWidth - first.offsetLeft + 1}px`;
      this.rangeBox.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop + 1}px`;
    }

    const host = this.editing ? this.cellEl(this.editing.row, this.editing.col) : null;
    this.cellInput.classList.toggle("is-on", Boolean(host));
    if (host) {
      this.cellInput.style.left = `${host.offsetLeft - 1}px`;
      this.cellInput.style.top = `${host.offsetTop - 1}px`;
      this.cellInput.style.width = `${host.offsetWidth + 2}px`;
      this.cellInput.style.height = `${host.offsetHeight + 2}px`;
    }
  }

  /* ------------------------------------------------------------- 选区 */

  private clampCell(row: number, col: number): Cell {
    return {
      row: Math.max(0, Math.min(row, this.model.body.length)),
      col: Math.max(0, Math.min(col, Math.max(0, this.model.header.length - 1))),
    };
  }

  private setBox(from: Cell, to: Cell): void {
    this.range = {
      r1: Math.min(from.row, to.row),
      c1: Math.min(from.col, to.col),
      r2: Math.max(from.row, to.row),
      c2: Math.max(from.col, to.col),
    };
  }

  /** Moves the active cell. With `extend`, the anchor stays put and the
      selection grows from it — which is what Shift means in a spreadsheet. */
  private moveTo(row: number, col: number, extend: boolean): void {
    const next = this.clampCell(row, col);
    if (extend) {
      this.active = next;
      this.setBox(this.anchor, next);
    } else {
      this.anchor = next;
      this.active = next;
      this.setBox(next, next);
    }
    this.refreshSelection();
  }

  private selectCell(row: number, col: number): void {
    const next = this.clampCell(row, col);
    this.anchor = next;
    this.active = next;
    this.setBox(next, next);
    this.refreshSelection();
  }

  /* ------------------------------------------------------------- 指针 */

  private wirePointer(): void {
    this.listen<MouseEvent>(this.gridHost, "mousedown", (event) => this.onPointerDown(event));
    this.listen<MouseEvent>(this.gridHost, "dblclick", (event) => this.onDoubleClick(event));
    this.listen<MouseEvent>(this.gridHost, "contextmenu", (event) => this.onContextMenu(event));
    this.listen<MouseEvent>(document, "mousemove", (event) => this.onPointerMove(event));
    this.listen<MouseEvent>(document, "mouseup", () => this.endDrag());
  }

  private endDrag(): void {
    if (this.drag?.mode === "colw") this.canvasEl.classList.remove("is-resizing-x");
    if (this.drag?.mode === "rowh") this.canvasEl.classList.remove("is-resizing-y");
    this.drag = null;
  }

  /** The grab target of a top-level `mousedown`, resizer included. */
  private resizerFrom(target: HTMLElement): HTMLElement | null {
    return target.closest<HTMLElement>(".mtk-col-resizer, .mtk-row-resizer");
  }

  private hit(target: HTMLElement): Hit | null {
    const cell = target.closest<HTMLElement>(".mtk-sheet-cell");
    if (!cell || !this.sheetEl.contains(cell)) return null;
    const head = cell.getAttribute("data-head");
    const filler = cell.classList.contains("is-filler");
    if (head === "col") return { head, row: -1, col: Number(cell.getAttribute("data-hcol")), filler };
    if (head === "row") return { head, row: Number(cell.getAttribute("data-hrow")), col: -1, filler };
    if (!cell.hasAttribute("data-row")) return null; // the corner cell
    return {
      head: null,
      row: Number(cell.getAttribute("data-row")),
      col: Number(cell.getAttribute("data-col")),
      filler,
    };
  }

  private onPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    /* Everything this gesture needs is read up front: committing the cell
       editor can rebuild the grid, which would detach the element the pointer
       is over. */
    const onHandle = this.fillHandle.contains(target);
    const hit = this.hit(target);
    const shift = event.shiftKey;

    if (this.editing) this.commitEdit();

    if (onHandle) {
      this.drag = { mode: "fill", from: { ...this.range } };
      event.preventDefault();
      return;
    }

    /* The resize edge lives *inside* a header cell, so the hit test below would
       cheerfully read it as a header click and select the whole column before
       the handle had moved a pixel. It is claimed here, ahead of everything
       else that looks at this event. */
    const edge = this.resizerFrom(target);
    if (edge) {
      this.startResize(edge, event);
      return;
    }

    if (!hit) return;

    if (hit.head === "col") {
      if (hit.filler) {
        this.addColumn();
        event.preventDefault();
        return;
      }
      this.commitInput();
      this.anchor = { row: 1, col: hit.col };
      this.active = { row: 1, col: hit.col };
      this.range = { r1: 0, c1: hit.col, r2: this.model.body.length, c2: hit.col };
      this.drag = { mode: "cols", start: hit.col };
      this.refreshSelection();
      event.preventDefault();
      return;
    }
    if (hit.head === "row") {
      if (hit.filler) {
        this.addRow();
        event.preventDefault();
        return;
      }
      this.commitInput();
      this.anchor = { row: hit.row, col: 0 };
      this.active = { row: hit.row, col: 0 };
      this.range = { r1: hit.row, c1: 0, r2: hit.row, c2: this.model.header.length - 1 };
      this.drag = { mode: "rows", start: hit.row };
      this.refreshSelection();
      event.preventDefault();
      return;
    }

    if (hit.filler) {
      /* An empty cell is a cell you can use: grow the table to reach it. */
      this.commitInput();
      this.extendTo(hit.row, hit.col);
      this.anchor = { row: hit.row, col: hit.col };
      this.active = { row: hit.row, col: hit.col };
      this.setBox(this.anchor, this.active);
      this.recompute();
      event.preventDefault();
      return;
    }

    this.commitInput();
    if (shift) {
      this.active = this.clampCell(hit.row, hit.col);
      this.setBox(this.anchor, this.active);
      this.refreshSelection();
    } else {
      this.selectCell(hit.row, hit.col);
      this.drag = { mode: "cells" };
    }
    event.preventDefault();
  }

  /**
   * Begins a size drag.
   *
   * The size the press started from is recorded now and never re-read: the grid
   * is rebuilt on every move, so measuring against "the current width" would
   * compound whatever the last render rounded to and the edge would drift away
   * from the pointer.
   */
  private startResize(edge: HTMLElement, event: MouseEvent): void {
    this.commitInput();
    event.preventDefault();
    if (edge.getAttribute("data-resize") === "col") {
      const col = Number(edge.getAttribute("data-c"));
      this.drag = { mode: "colw", col, startX: event.clientX, startW: this.colWidth(col) };
      this.canvasEl.classList.add("is-resizing-x");
    } else {
      const row = Number(edge.getAttribute("data-r"));
      this.drag = { mode: "rowh", row, startY: event.clientY, startH: this.rowHeight(row) };
      this.canvasEl.classList.add("is-resizing-y");
    }
  }

  private onDoubleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    /* Double-clicking an edge puts that one column or row back to its default.
       A drag has to have a way back that does not consist of guessing the
       original size by hand. */
    const edge = this.resizerFrom(target);
    if (edge) {
      event.preventDefault();
      if (edge.getAttribute("data-resize") === "col") {
        this.colW[Number(edge.getAttribute("data-c"))] = undefined;
      } else {
        this.rowH[Number(edge.getAttribute("data-r"))] = undefined;
      }
      this.renderGrid();
      return;
    }

    const hit = this.hit(target);
    if (!hit || hit.head || hit.filler) return;
    this.startEdit(hit.row, hit.col);
  }

  private onPointerMove(event: MouseEvent): void {
    const drag = this.drag;
    if (!drag) return;

    /* A size drag is the one gesture that does not need a cell under the
       pointer: pulling an edge out past the canvas is allowed, and letting go
       the moment the pointer left the grid would read as the handle being
       dropped. So both of these come before the hit test. */
    if (drag.mode === "colw") {
      const width = clamp(drag.startW + (event.clientX - drag.startX), MIN_COL_W, MAX_COL_W);
      if (width !== this.colWidth(drag.col)) this.setColWidth(drag.col, width);
      return;
    }
    if (drag.mode === "rowh") {
      const height = clamp(drag.startH + (event.clientY - drag.startY), MIN_ROW_H, MAX_ROW_H);
      if (height !== this.rowHeight(drag.row)) this.setRowHeight(drag.row, height);
      return;
    }

    const target = event.target as HTMLElement | null;
    const hit = target ? this.hit(target) : null;
    if (!hit) return;

    switch (drag.mode) {
      case "cells": {
        if (hit.head || hit.filler) return;
        if (hit.row === this.active.row && hit.col === this.active.col) return;
        this.active = { row: hit.row, col: hit.col };
        this.setBox(this.anchor, this.active);
        this.refreshSelection();
        return;
      }
      case "cols": {
        if (hit.col < 0) return;
        const c1 = Math.min(drag.start, hit.col);
        const c2 = Math.max(drag.start, hit.col);
        this.range = { r1: 0, c1, r2: this.model.body.length, c2 };
        this.refreshSelection();
        return;
      }
      case "rows": {
        if (hit.row < 0) return;
        const r1 = Math.min(drag.start, hit.row);
        const r2 = Math.max(drag.start, hit.row);
        this.range = { r1, c1: 0, r2, c2: this.model.header.length - 1 };
        this.refreshSelection();
        return;
      }
      case "fill": {
        if (hit.row < 0 || hit.col < 0) return;
        const from = drag.from;
        const inside =
          hit.row >= from.r1 && hit.row <= from.r2 && hit.col >= from.c1 && hit.col <= from.c2;
        if (inside) {
          this.range = { ...from };
          this.refreshSelection();
          return;
        }
        this.applyFill({ row: hit.row, col: hit.col });
        return;
      }
      default:
        return;
    }
  }

  /* --------------------------------------------------------- 行列右键菜单 */

  /**
   * A right-click on a column letter or a row number offers the three things
   * you can do to a whole column or row.
   *
   * The menu is Obsidian's own `Menu`, the same one the ƒ button opens: it is a
   * list of commands, so keyboard handling, placement and the theme's layering
   * are already its business. A hand-drawn menu would have to re-derive all
   * three, and the layering one in particular is not something a prototype can
   * check.
   */
  private onContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const hit = this.hit(target);
    /* A data cell keeps the browser's own menu: it has the copy and spelling
       items people expect there, and none of these three would apply to one
       cell anyway. */
    if (!hit || !hit.head) return;
    /* Past the table there is no column or row behind the header, so all three
       items would do nothing. Better to show nothing at all. */
    if (hit.filler) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    const head = hit.head;
    const index = head === "col" ? hit.col : hit.row;
    this.commitInput();

    /* Excel's manners: take the whole column or row first, so which one the
       menu is about is visible before anything in it is clicked. */
    if (head === "col") {
      this.anchor = { row: 1, col: index };
      this.active = { row: 1, col: index };
      this.range = { r1: 0, c1: index, r2: this.model.body.length, c2: index };
    } else {
      this.anchor = { row: index, col: 0 };
      this.active = { row: index, col: 0 };
      this.range = { r1: index, c1: 0, r2: index, c2: this.model.header.length - 1 };
    }
    this.refreshSelection();

    const menu = new Menu();
    if (head === "col") {
      menu.addItem((item) =>
        item
          .setTitle(t("table.col.insertBefore"))
          .setIcon("plus")
          .onClick(() => this.insertColumnBefore(index))
      );
      menu.addItem((item) => {
        item
          .setTitle(t("table.col.delete"))
          .setIcon("trash-2")
          .onClick(() => this.deleteColumn(index));
        /* A table with no columns is not a table. */
        if (this.model.header.length <= 1) item.setDisabled(true);
      });
      menu.addItem((item) =>
        item
          .setTitle(t("table.col.append"))
          .setIcon("plus")
          .onClick(() => this.appendColumn())
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle(t("table.row.insertBefore"))
          .setIcon("plus")
          .onClick(() => this.insertRowBefore(index))
      );
      menu.addItem((item) => {
        item
          .setTitle(t("table.row.delete"))
          .setIcon("trash-2")
          .onClick(() => this.deleteRow(index));
        /* Row 1 is the Markdown header row, and the table does not survive
           without it. */
        if (index === 0) item.setDisabled(true);
      });
      menu.addItem((item) =>
        item
          .setTitle(t("table.row.append"))
          .setIcon("plus")
          .onClick(() => this.appendRow())
      );
    }
    menu.showAtMouseEvent(event);
  }

  /* ------------------------------------------------------------- 键盘 */

  private wireKeyboard(): void {
    this.listen<KeyboardEvent>(document, "keydown", (event) => this.onKeyDown(event));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target === this.inputEl || target === this.cellInput) return;

    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        void this.copyRange();
      } else if (key === "v") {
        event.preventDefault();
        void this.pasteClipboard();
      }
      return;
    }

    switch (event.key) {
      case "ArrowUp":
        this.moveTo(this.active.row - 1, this.active.col, event.shiftKey);
        break;
      case "ArrowDown":
        this.moveTo(this.active.row + 1, this.active.col, event.shiftKey);
        break;
      case "ArrowLeft":
        this.moveTo(this.active.row, this.active.col - 1, event.shiftKey);
        break;
      case "ArrowRight":
        this.moveTo(this.active.row, this.active.col + 1, event.shiftKey);
        break;
      case "Tab":
        this.moveTo(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), false);
        break;
      case "Enter":
        this.moveTo(this.active.row + (event.shiftKey ? -1 : 1), this.active.col, false);
        break;
      case "F2":
        this.startEdit(this.active.row, this.active.col);
        break;
      case "Delete":
      case "Backspace":
        this.clearRange();
        break;
      default:
        if (event.key.length === 1 && !event.altKey) {
          this.startEdit(this.active.row, this.active.col, event.key);
          break;
        }
        return;
    }
    event.preventDefault();
  }

  /* ------------------------------------------------------------- 编辑 */

  private syncBar(): void {
    const { row, col } = this.active;
    this.refLabel.textContent = columnLetter(col) + (row + 1);
    if (!this.editing) this.inputEl.value = this.rawAt(row, col);
  }

  private rawAt(row: number, col: number): string {
    if (row === 0) return this.model.header[col] ?? "";
    return this.model.body[row - 1]?.[col] ?? "";
  }

  private writeCell(row: number, col: number, value: string): void {
    if (col < 0 || col >= this.model.header.length) return;
    if (row === 0) {
      this.model.header[col] = value;
      return;
    }
    const target = this.model.body[row - 1];
    if (target) target[col] = value;
  }

  /** Commits whatever the formula bar holds into the active cell. */
  private commitInput(): void {
    if (this.editing) return;
    const { row, col } = this.active;
    const value = this.inputEl.value.trim();
    if (value === this.rawAt(row, col)) return;
    this.writeCell(row, col, value);
    this.recompute();
  }

  private wireCellInput(): void {
    this.cellInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitEdit();
        this.moveTo(this.active.row + 1, this.active.col, false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.commitEdit();
        this.moveTo(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), false);
      } else if (event.key === "Escape") {
        /* Stop here so the modal's own Escape (close) does not also fire. */
        event.preventDefault();
        event.stopPropagation();
        this.cancelEdit();
      }
    });
    this.cellInput.addEventListener("input", () => {
      this.inputEl.value = this.cellInput.value;
    });
    this.cellInput.addEventListener("blur", () => this.commitEdit());
  }

  private startEdit(row: number, col: number, initial?: string): void {
    this.commitInput();
    this.editing = { row, col };
    this.anchor = { row, col };
    this.active = { row, col };
    this.setBox({ row, col }, { row, col });
    this.refreshSelection();
    this.cellInput.value = initial ?? this.rawAt(row, col);
    this.cellInput.focus();
    if (initial === undefined) this.cellInput.select();
    this.inputEl.value = this.cellInput.value;
  }

  private cancelEdit(): void {
    this.editing = null;
    this.refreshSelection();
  }

  /** Writes the in-cell editor's text back and closes it. Does not move. */
  private commitEdit(): void {
    if (!this.editing) return;
    const { row, col } = this.editing;
    const value = this.cellInput.value.trim();
    const changed = value !== this.rawAt(row, col);
    this.editing = null;
    if (changed) {
      this.writeCell(row, col, value);
      this.recompute();
    } else {
      this.refreshSelection();
    }
  }

  /* ----------------------------------------------------------- 批量操作 */

  private clearRange(): void {
    let changed = false;
    for (let row = this.range.r1; row <= this.range.r2; row += 1) {
      for (let col = this.range.c1; col <= this.range.c2; col += 1) {
        if (this.rawAt(row, col) !== "") {
          this.writeCell(row, col, "");
          changed = true;
        }
      }
    }
    if (changed) this.recompute();
  }

  /** The selection as TSV, which is what a spreadsheet pastes back. */
  private async copyRange(): Promise<void> {
    const lines: string[] = [];
    for (let row = this.range.r1; row <= this.range.r2; row += 1) {
      const cells: string[] = [];
      for (let col = this.range.c1; col <= this.range.c2; col += 1) cells.push(this.rawAt(row, col));
      lines.push(cells.join("\t"));
    }
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      /* A denied clipboard is not worth a notice — the user can retype. */
    }
  }

  private async pasteClipboard(): Promise<void> {
    if (!navigator.clipboard) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;

    const rows = text.replace(/\r\n?/g, "\n").split("\n");
    if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
    const width = Math.max(...rows.map((line) => line.split("\t").length));

    const startRow = this.active.row;
    const startCol = this.active.col;
    /* Pasting past the edge grows the table, the same courtesy clicking an
       empty cell gets. */
    this.extendTo(startRow + rows.length - 1, startCol + width - 1);
    rows.forEach((line, i) => {
      line.split("\t").forEach((value, j) => this.writeCell(startRow + i, startCol + j, value));
    });

    this.anchor = { row: startRow, col: startCol };
    this.active = { row: startRow + rows.length - 1, col: startCol + width - 1 };
    this.setBox(this.anchor, this.active);
    this.recompute();
  }

  /* ----------------------------------------------------------- 填充 */

  private fillSeries(values: string[], step: number): string {
    const numbers = values.map((value) => {
      const trimmed = value.trim();
      return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
    });
    const allInts = values.length >= 2 && numbers.every((n) => n !== null);
    if (allInts) {
      const gap = (numbers[1] as number) - (numbers[0] as number);
      return String((numbers[numbers.length - 1] as number) + gap * (step + 1));
    }
    return values[step % values.length];
  }

  private applyFill(target: Cell): void {
    if (!this.drag || this.drag.mode !== "fill") return;
    const from = this.drag.from;
    let step = 0;

    if (target.row > from.r2) {
      this.extendTo(target.row, from.c2);
      for (let row = from.r2 + 1; row <= target.row; row += 1) {
        for (let col = from.c1; col <= from.c2; col += 1) {
          const values: string[] = [];
          for (let r = from.r1; r <= from.r2; r += 1) values.push(this.rawAt(r, col));
          this.writeCell(row, col, this.fillSeries(values, step));
        }
        step += 1;
      }
    } else if (target.row < from.r1) {
      for (let row = from.r1 - 1; row >= Math.max(1, target.row); row -= 1) {
        for (let col = from.c1; col <= from.c2; col += 1) {
          const values: string[] = [];
          for (let r = from.r1; r <= from.r2; r += 1) values.push(this.rawAt(r, col));
          this.writeCell(row, col, this.fillSeries(values, step));
        }
        step += 1;
      }
    } else if (target.col > from.c2) {
      this.extendTo(from.r2, target.col);
      for (let col = from.c2 + 1; col <= target.col; col += 1) {
        for (let row = from.r1; row <= from.r2; row += 1) {
          const values: string[] = [];
          for (let c = from.c1; c <= from.c2; c += 1) values.push(this.rawAt(row, c));
          this.writeCell(row, col, this.fillSeries(values, step));
        }
        step += 1;
      }
    } else if (target.col < from.c1) {
      for (let col = from.c1 - 1; col >= Math.max(0, target.col); col -= 1) {
        for (let row = from.r1; row <= from.r2; row += 1) {
          const values: string[] = [];
          for (let c = from.c1; c <= from.c2; c += 1) values.push(this.rawAt(row, c));
          this.writeCell(row, col, this.fillSeries(values, step));
        }
        step += 1;
      }
    }

    this.anchor = { row: from.r1, col: from.c1 };
    this.active = { row: from.r2, col: from.c2 };
    this.range = { ...from };
    this.recompute();
  }

  /* ----------------------------------------------------------- 扩表 */

  /** Grows the table until the cell at `row`/`col` is a real cell. */
  private extendTo(row: number, col: number): void {
    while (this.model.header.length <= col) {
      this.model.header.push("");
      this.model.body.forEach((cells) => cells.push(""));
      this.model.align.push("default");
    }
    while (this.model.body.length < row) {
      this.model.body.push(this.model.header.map(() => ""));
    }
  }

  /* ----------------------------------------------------------- 公式 */

  /**
   * Writes `=fn(col<from>:col<to>)` into the active cell.
   *
   * The range is the run of numbers directly above the cell, which is what a
   * spreadsheet's "sum above" does. Its limit is worth stating plainly: it can
   * tell a number from a word, and it **cannot** tell a data row from a totals
   * row, because both are numbers. So the cell this is aimed at is a totals
   * row — putting it under a totals row would double-count, and there is nothing
   * here that could know better.
   */
  /* ------------------------------------------------------- 公式栏下拉 */

  /** Opens a dropdown of every cell in the table and jumps to the one picked. */
  private openRefMenu(event: MouseEvent): void {
    const menu = new Menu();
    const cols = this.model.header.length;
    const rows = this.model.body.length + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const addr = columnLetter(c) + (r + 1);
        menu.addItem((item) => item.setTitle(addr).onClick(() => this.selectCell(r, c)));
      }
    }
    const rect = this.refBox.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
    event.stopPropagation();
  }

  /** Opens the aggregate-function menu — the ƒ menu that used to live in the toolbar. */
  private openFxMenu(event: MouseEvent): void {
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
  }

  private insertFormula(name: string): void {
    const { row, col } = this.active;
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
  }
}
