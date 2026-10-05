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
  | { mode: "fill"; from: Box };

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

  private canvasEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private sheetEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private refEl!: HTMLElement;
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
    this.refEl = h("span", { cls: "ref" });
    bar.appendChild(this.refEl);
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
    bar.appendChild(this.inputEl);
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
      cell.style.width = `${plan.columnWidth}px`;
      headRow.appendChild(cell);
    }
    sheet.appendChild(headRow);

    for (let row = 0; row < plan.rows; row += 1) {
      sheet.appendChild(this.buildRow(row, plan.columnWidth, plan.columns));
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

  private buildRow(row: number, columnWidth: number, columns: number): HTMLElement {
    const tr = h("div", { cls: "mtk-sheet-row" });
    /* A row number is filler under exactly the boundary its data cells use, so
       "the number below the table" and "the cell below the table" are one
       gesture rather than two that almost agree. Which of them a click grew the
       table was, for a while, a difference the code could not tell apart: the
       number never carried the class, so the branch that adds a row was dead. */
    tr.appendChild(
      h("div", {
        cls:
          "mtk-sheet-cell mtk-sheet-gutter" +
          (row > this.model.body.length ? " is-filler" : ""),
        text: String(row + 1),
        attr: { "data-head": "row", "data-hrow": String(row) },
      })
    );

    const values = row === 0 ? this.model.header : this.model.body[row - 1];

    for (let col = 0; col < columns; col += 1) {
      const cell = h("div", {
        cls: "mtk-sheet-cell",
        attr: { "data-row": String(row), "data-col": String(col) },
      });
      cell.style.width = `${columnWidth}px`;

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
    this.listen<MouseEvent>(document, "mousemove", (event) => this.onPointerMove(event));
    this.listen<MouseEvent>(document, "mouseup", () => {
      this.drag = null;
    });
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

  private onDoubleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const hit = this.hit(target);
    if (!hit || hit.head || hit.filler) return;
    this.startEdit(hit.row, hit.col);
  }

  private onPointerMove(event: MouseEvent): void {
    if (!this.drag) return;
    const target = event.target as HTMLElement | null;
    const hit = target ? this.hit(target) : null;
    if (!hit) return;

    switch (this.drag.mode) {
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
        const c1 = Math.min(this.drag.start, hit.col);
        const c2 = Math.max(this.drag.start, hit.col);
        this.range = { r1: 0, c1, r2: this.model.body.length, c2 };
        this.refreshSelection();
        return;
      }
      case "rows": {
        if (hit.row < 0) return;
        const r1 = Math.min(this.drag.start, hit.row);
        const r2 = Math.max(this.drag.start, hit.row);
        this.range = { r1, c1: 0, r2, c2: this.model.header.length - 1 };
        this.refreshSelection();
        return;
      }
      case "fill": {
        if (hit.row < 0 || hit.col < 0) return;
        const from = this.drag.from;
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
    this.refEl.textContent = columnLetter(col) + (row + 1);
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
