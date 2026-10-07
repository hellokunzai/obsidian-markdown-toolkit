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
 * move blocks through the clipboard, and the empty cells past the edge, which
 * the table grows to reach the moment one of them is *edited*. Growth is tied
 * to editing and not to clicking, on purpose: a grid that adds a row because
 * someone clicked near it is a grid you cannot look at without changing it.
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
import { Menu, Modal, Notice, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { h } from "../utils/dom";
import { tagModalCloseButton } from "../utils/modal-fullscreen";
import { applyTooltip } from "../utils/tooltip";
import {
  columnLetter,
  evaluateTable,
  type CellResult,
  type TableAlign,
  type TableModel,
} from "../core/table-formula";
import type { TableFillMode } from "../settings";
import { THEME_ROWS, STANDARD_COLORS, FONT_COLOR_ICON } from "../core/font-color";
import { TRANSLUCENT_COLORS, HIGHLIGHTER_COLORS, BACKGROUND_COLOR_ICON } from "../core/background-color";
import {
  readColorSpan,
  writeColorProp,
  normalizeHex,
  normalizeColor,
  type ColorProp,
} from "../core/color-span";
import { ColorPickerPanel, closeColorPicker, type ColorBand } from "../ui/color-picker";

export interface TableEditorRequest {
  app: App;
  model: TableModel;
  fillMode: TableFillMode;
  /** Called with the edited model when the user saves. A caller that has to
      write to disk returns a promise, so the panel can acknowledge the save
      only once the write has landed. */
  onSave: (model: TableModel) => void | Promise<void>;
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

/** How far past the table's own size the filler grid may grow before it stops.
 *  A finite cap keeps the DOM bounded while still feeling endless in practice. */
const GROW_CAP = 60;
/** Filler columns/rows kept rendered beyond the visible edge, so a scroll lands
 *  on grid rather than blank space — and the next grow has somewhere to start. */
const H_BUFFER = 12;
const V_BUFFER = 9;

/**
 * Ctrl+滚轮缩放的档位表（50%–300%，与 chart-panel 同一量级）。
 *
 * 走固定档位而不是「乘以 1.1」有两个原因：读数是整的（不会出现 121%、133%
 * 这种没人报得出的比例），以及不会有浮点累积——连按十几次之后 1 已经是
 * 0.9999999999999998，`zoom === 1` 的判定就再也命中不了。
 */
const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
/** 100% 在档位表里的下标，也是 `zoomReset` 的目标。 */
const ZOOM_DEFAULT_INDEX = ZOOM_STEPS.indexOf(1);

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
  /* Row and column drags keep the rectangle the press started from and grow
     it along their own axis only. The other axis is settled at press time —
     a column letter covers the whole height, and a Shift-press may have
     pulled rows in from the anchor — so it must not move as the pointer
     wanders. */
  | { mode: "cols"; from: Box }
  | { mode: "rows"; from: Box }
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
  /** Set on the top-left corner cell: clicking it selects the whole table. */
  corner?: boolean;
}

/** What the anchor covers. A Shift-extended selection is the union of the
    anchor's rectangle and the one under the pointer, and a column letter
    covers every row while a cell covers one square — so the anchor has to
    remember which of the three it was, not only where it was clicked. */
type AnchorKind = "cell" | "col" | "row";

class TablePanel extends Modal {
  private readonly request: TableEditorRequest;
  /** A copy: cancelling must leave the note's table exactly as it was. */
  private model: TableModel;
  private results: CellResult[][];

  /** The fixed corner a Shift-extended selection grows from. */
  private anchor: Cell = { row: 1, col: 0 };
  /** Whether that anchor is a cell, a whole column, or a whole row. */
  private anchorKind: AnchorKind = "cell";
  /** The moving cell: what the formula bar, headers and keyboard act on. */
  private active: Cell = { row: 1, col: 0 };
  private range: Box = { r1: 1, c1: 0, r2: 1, c2: 0 };
  private editing: Cell | null = null;
  private drag: Drag | null = null;
  /**
   * True only while the corner-cell "select the whole table" is in effect.
   * The anchor is kept a plain `"cell"` (never `"col"`/`"row"`) so both header
   * strips light up — which is exactly what "the whole sheet" should say.
   */
  private selectAll = false;

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
  /** Columns/rows drawn so far (real plus filler). Cumulative: once grown it
   *  stays, so scrolling back keeps what you already reached. `ensureBuffer`
   *  raises it as the user scrolls toward an edge. */
  private renderedCols = 0;
  private renderedRows = 0;
  /** 格式刷装填后的缓冲区；为 `null` 表示未装填。 */
  private brushBuffer: { align: TableAlign; color: string | null; bg: string | null } | null = null;
  /** 格式刷工具栏按钮，用于装填 / 刷出时切换高亮。 */
  private brushBtn: HTMLButtonElement | null = null;

  /**
   * 表格弹窗视图缩放，1 = 100%，仅视图状态、不写回笔记。
   *
   * 实现方式是「按真实尺寸重排」而不是 `transform: scale()`：网格的每一格都
   * 直接按 `未缩放尺寸 × zoom` 落成 px，字号与边框经 `--mtk-zoom` 一起走
   * `calc()`。这与 Excel 的缩放是同一件事——放大是真的把格子放大，不是把一张
   * 画好的图拉伸。三个后果都是白拿的：文字按新字号重新栅格化（不糊）、
   * `position: sticky` 的表头和行号不受影响（transform 会让它们失效）、滚动范围
   * 由布局自己算出来（不必再拿一个撑尺寸的层去假装）。
   */
  private zoom = 1;
  /** 工具条上的百分比标签，点击复位 100%。 */
  private zoomPctEl: HTMLElement | null = null;

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

    /* Grow filler cells as the user scrolls toward an edge, so the grid feels
       endless rather than being capped at the viewport. */
    const onGridScroll = (): void => {
      this.ensureBuffer();
    };
    this.gridHost.addEventListener("scroll", onGridScroll, { passive: true });
    this.teardown.push(() => this.gridHost.removeEventListener("scroll", onGridScroll));

    /* Ctrl + 滚轮缩放表格，与 chart-panel 同一手势。
       `passive: false` 才能 preventDefault —— 不然 Ctrl+滚轮会先被浏览器当成
       「页面缩放」吃掉，网格再跟着跳一次。
       触控板的双指捏合在 Chromium 里也走 wheel + ctrlKey，所以捏合顺带就能用。 */
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      this.zoomStep(event.deltaY < 0 ? 1 : -1);
    };
    this.gridHost.addEventListener("wheel", onWheel, { passive: false });
    this.teardown.push(() => this.gridHost.removeEventListener("wheel", onWheel));
  }

  onClose(): void {
    closeColorPicker();
    this.brushBuffer = null;
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
        void this.saveModel();
      })
    );
    this.toolbarEl.appendChild(this.divider());

    /* 顶栏现在只有 保存 · 分隔线 · 六个格式按钮 —— 「加一行 / 加一列」两个
       按钮已按用户要求移除。增删行列本来就有格子上的手势在管（点表外的行号 /
       列标加一行 / 一列，双击占位格进入编辑即扩表），顶栏再摆两个同义按钮只会
       让人以为「加行只能从这儿来」。 */

    /* 格式组：格式刷 / 左·中·右对齐 / 背景色 / 字体色。
       对齐是表格原生语法（写进分隔行，随保存持久化）；颜色按用户拍板写回
       笔记内联 <span>（公式单元格 `=` 跳过，否则会埋掉公式）。 */
    const brushBtn = this.button("", "paintbrush", t("table.formatBrush"), () => this.formatBrush());
    this.brushBtn = brushBtn;
    this.toolbarEl.appendChild(brushBtn);
    this.toolbarEl.appendChild(
      this.button("", "align-left", t("table.align.left"), () => this.applyAlign("left"))
    );
    this.toolbarEl.appendChild(
      this.button("", "align-center", t("table.align.center"), () => this.applyAlign("center"))
    );
    this.toolbarEl.appendChild(
      this.button("", "align-right", t("table.align.right"), () => this.applyAlign("right"))
    );
    this.toolbarEl.appendChild(
      this.button("", BACKGROUND_COLOR_ICON, t("table.color.background"), (event) =>
        this.openColorPicker("bg", event.currentTarget as HTMLElement)
      )
    );
    this.toolbarEl.appendChild(
      this.button("", FONT_COLOR_ICON, t("table.color.font"), (event) =>
        this.openColorPicker("font", event.currentTarget as HTMLElement)
      )
    );

    /* 缩放组：与 chart-panel 对齐的 zoomOut / zoomLabel / zoomIn。
       Ctrl+滚轮已能缩放，按钮给没有滚轮 / 触板的场景一个入口，
       百分比标签点击复位 100%。两条路都走 `zoomStep`，不会各缩各的。 */
    const zoomGroup = h("span", { cls: "mtk-zoom-group" });
    const zOut = this.button("", "zoom-out", t("table.zoom.out"), () => this.zoomStep(-1));
    const zPct = h("span", { cls: "mtk-zoom-pct", text: "100%" });
    applyTooltip(zPct, t("table.zoom.reset"));
    zPct.addEventListener("click", () => this.zoomReset());
    const zIn = this.button("", "zoom-in", t("table.zoom.in"), () => this.zoomStep(1));
    zoomGroup.appendChild(zOut);
    zoomGroup.appendChild(zPct);
    zoomGroup.appendChild(zIn);
    this.toolbarEl.appendChild(zoomGroup);
    this.zoomPctEl = zPct;
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

  /* ------------------------------------------------------------- 视图缩放 */

  /** 沿档位表走一格：`direction` 为 +1 放大、-1 缩小（滚轮与工具条共用）。 */
  private zoomStep(direction: 1 | -1): void {
    const at = ZOOM_STEPS.indexOf(this.zoom);
    /* indexOf 落空（理论上不会）时从最近的一档重新出发，而不是把缩放顶到 100% */
    const from = at >= 0 ? at : ZOOM_DEFAULT_INDEX;
    const to = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction));
    if (to === from) return;
    this.zoomTo(ZOOM_STEPS[to]);
  }

  /** 点击百分比标签：回到 100%。 */
  private zoomReset(): void {
    this.zoomTo(1);
  }

  /**
   * 把缩放设到 `next`（只接受档位表里的值）。
   *
   * 锚点是**视口左上角**，这是 Excel 的做法：左上角那个格子缩放后还落在左上角
   * （用户给的三张参考图里 A1 在三个比例下都钉在左上角，正是这条规则）。滚动量
   * 是「显示像素」，除以旧 zoom 还原成内容坐标，再乘新 zoom 落回同一格。
   *
   * 缩放改了每个格子的真实尺寸，所以整棵树要重排——这也是为什么滚轮不做动画、
   * 一格一跳：每一跳都要重建网格，中间态没有意义。
   */
  private zoomTo(next: number): void {
    if (next === this.zoom) return;
    const host = this.gridHost;
    const ux = host.scrollLeft / this.zoom;
    const uy = host.scrollTop / this.zoom;
    this.zoom = next;
    this.renderGrid();
    /* 要在重排之后写：`renderGrid` 会把重建前的滚动位置按旧尺度还原回去，
       这两行才是按新尺度落位的那一次。 */
    host.scrollLeft = ux * next;
    host.scrollTop = uy * next;
    this.updateZoomLabel();
  }

  private updateZoomLabel(): void {
    if (this.zoomPctEl) this.zoomPctEl.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  /* 缩放后的真实像素。字号与边框不经这里，它们走 CSS 的 `--mtk-zoom`
     （见 styles.css），因为那些值本来就归样式表管。 */
  private colPx(col: number): number {
    return this.colWidth(col) * this.zoom;
  }

  private rowPx(row: number): number {
    return this.rowHeight(row) * this.zoom;
  }

  private gutterPx(): number {
    return GUTTER_WIDTH * this.zoom;
  }

  private headPx(): number {
    return HEAD_HEIGHT * this.zoom;
  }

  /**
   * Writes the table back and **keeps the dialog open**.
   *
   * Closing on save is what a "commit and leave" dialog does, and it is not what
   * this panel is: the mind-map and chart panels have always stayed open on
   * save, and this panel grew out of the same shell. A table is also the one
   * place where saving is a checkpoint rather than the end of the task — you
   * save a formula, then keep typing rows. The notice is what the close used to
   * say, minus the part that threw away the grid the user was working in.
   *
   * The write is awaited before the notice so it reports what happened rather
   * than what was requested; a caller that writes nothing (the live-preview
   * path returns synchronously) still gets an immediate acknowledgement.
   */
  private async saveModel(): Promise<void> {
    this.commitInput();
    await this.request.onSave(this.model);
    new Notice(t("notice.tableSaved"));
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

  /* ----------------------------------------------------- 格式组（阶段二） */

  /**
   * 把选区覆盖的每一列，整体切换成 `kind` 对齐；若这些列已经**全部**是
   * `kind`，则整体退回默认（再按一次即取消）。
   *
   * 对齐写进 `model.align`，随保存落进分隔行（`:---` / `:---:` / `---:`），
   * 是表格原生语法、可永久持久化，别的编辑器也认。Markdown 表格无
   * `justify`，所以只给左 / 中 / 右三档。
   */
  private applyAlign(kind: "left" | "center" | "right"): void {
    this.commitInput();
    const last = this.model.align.length - 1;
    const c1 = Math.min(this.range.c1, last);
    const c2 = Math.min(this.range.c2, last);
    if (c1 < 0 || c2 < 0 || c1 > last) return;

    let already = true;
    for (let c = c1; c <= c2; c += 1) {
      if (this.model.align[c] !== kind) {
        already = false;
        break;
      }
    }
    for (let c = c1; c <= c2; c += 1) this.model.align[c] = already ? "default" : kind;
    this.recompute();
  }

  /**
   * 格式刷：两击式（与 Excel 单击模式一致）。
   *
   * 第一击「装填」：把**当前活动单元格**的列对齐 + 单元格颜色读进缓冲区，
   * 按钮点亮；第二击「刷出」：把缓冲区套用到**当前选区**，然后熄灯。这样
   * 用户可以先点源格、再框选目标、再点刷子，源格不会因移动选区而丢。
   * 公式单元格（`=` 开头）跳过颜色（上色会埋掉 `=` 让公式失效）。
   */
  private formatBrush(): void {
    if (!this.brushBuffer) {
      const raw = this.rawAt(this.active.row, this.active.col);
      const span = readColorSpan(raw);
      this.brushBuffer = {
        align: this.model.align[this.active.col] ?? "default",
        color: span?.props.color ?? null,
        bg: span?.props["background-color"] ?? null,
      };
      this.refreshBrushButton(true);
      return;
    }

    const buf = this.brushBuffer;
    this.brushBuffer = null;
    this.refreshBrushButton(false);

    const last = this.model.align.length - 1;
    const { r1, r2 } = this.range;
    const c1 = Math.min(this.range.c1, last);
    const c2 = Math.min(this.range.c2, last);

    for (let c = c1; c <= c2; c += 1) this.model.align[c] = buf.align;

    let changed = false;
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const raw = this.rawAt(r, c);
        if (raw.startsWith("=")) continue;
        let next = writeColorProp(raw, "color", buf.color);
        next = writeColorProp(next, "background-color", buf.bg);
        if (next !== raw) {
          this.writeCell(r, c, next);
          changed = true;
        }
      }
    }
    this.recompute();
  }

  /** 格式刷装填时点亮按钮，刷出后熄灯。 */
  private refreshBrushButton(on: boolean): void {
    this.brushBtn?.classList.toggle("is-on", on);
  }

  /**
   * 打开调色板，锚定到工具栏的颜色按钮。字体色走方块十列（hex 语法），
   * 背景色走圆形五列（含 `rgb()` / `rgba()` 透明语法）。选中的颜色统一
   * 应用到当前选区（公式单元格跳过）。
   */
  private openColorPicker(kind: "font" | "bg", anchor: HTMLElement): void {
    const isFont = kind === "font";
    const bands: ColorBand[] = isFont
      ? [
          { caption: t("fontColor.colors.theme"), colors: THEME_ROWS.flat() },
          { caption: t("fontColor.colors.standard"), colors: STANDARD_COLORS },
        ]
      : [
          { caption: t("backgroundColor.colors.translucent"), colors: TRANSLUCENT_COLORS },
          { caption: t("backgroundColor.colors.highlighter"), colors: HIGHLIGHTER_COLORS },
        ];

    const activeSpan = readColorSpan(this.rawAt(this.active.row, this.active.col));
    const current = activeSpan?.props[isFont ? "color" : "background-color"];
    const seed = current ?? (isFont ? "#ff0000" : "rgb(255,248,143)");

    new ColorPickerPanel({
      title: isFont ? t("table.color.font") : t("table.color.background"),
      bands,
      round: !isFont,
      anchor,
      accepts: isFont ? normalizeHex : normalizeColor,
      seed,
      current,
      onPick: (picked) => this.applyColorToSelection(kind, picked),
    }).open();
  }

  /**
   * 把 `color` 应用到当前选区（字体色 → `color`，背景色 → `background-color`）。
   *
   * 整段选区**统一**决定「上色 / 撤色」：若选区内每个非公式单元格已是该色，
   * 则统一撤下，否则统一套上——避免逐格翻转（一半保留一半上色）。公式单元格
   * 跳过，因其 raw 以 `=` 开头，上色会破坏公式。
   */
  private applyColorToSelection(kind: "font" | "bg", color: string): void {
    this.commitInput();
    const prop: ColorProp = kind === "font" ? "color" : "background-color";
    const normalize = kind === "font" ? normalizeHex : normalizeColor;
    const target = normalize(color);
    if (!target) return;

    const last = this.model.align.length - 1;
    const { r1, r2 } = this.range;
    const c1 = Math.min(this.range.c1, last);
    const c2 = Math.min(this.range.c2, last);

    const cells: Array<{ r: number; c: number; raw: string }> = [];
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const raw = this.rawAt(r, c);
        if (raw.startsWith("=")) continue;
        cells.push({ r, c, raw });
      }
    }
    if (cells.length === 0) return;

    const remove = cells.every(({ raw }) => readColorSpan(raw)?.props[prop] === target);
    let changed = false;
    for (const { r, c, raw } of cells) {
      const next = writeColorProp(raw, prop, remove ? null : target);
      if (next !== raw) {
        this.writeCell(r, c, next);
        changed = true;
      }
    }
    if (changed) this.recompute();
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
    this.deleteColumns([col]);
  }

  private deleteColumns(cols: number[]): void {
    const valid = [...new Set(cols)]
      .filter((c) => c >= 0 && c < this.model.header.length)
      .sort((a, b) => a - b);
    /* A table with no columns is not a table: never delete them all. */
    if (valid.length === 0 || valid.length >= this.model.header.length) return;
    this.commitInput();
    /* Largest index first so each splice keeps the others valid. */
    for (let i = valid.length - 1; i >= 0; i--) {
      const c = valid[i];
      this.model.header.splice(c, 1);
      this.model.body.forEach((cells) => cells.splice(c, 1));
      this.model.align.splice(c, 1);
    }
    this.recompute();
    this.selectCell(this.active.row, Math.min(valid[0], this.model.header.length - 1));
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
    this.deleteRows([row]);
  }

  private deleteRows(rows: number[]): void {
    /* Row 1 (index 0) is the Markdown header row, and the table does not
       survive without it, so it is never part of a deletion. */
    const valid = [...new Set(rows)]
      .filter((r) => r > 0 && r <= this.model.body.length)
      .sort((a, b) => a - b);
    if (valid.length === 0) return;
    this.commitInput();
    /* Largest index first so each splice keeps the others valid. */
    for (let i = valid.length - 1; i >= 0; i--) {
      this.model.body.splice(valid[i] - 1, 1);
    }
    this.recompute();
    this.selectCell(Math.max(1, Math.min(valid[0], this.model.body.length)), this.active.col);
  }

  /** Column indices covered by the current column/row range. */
  private rangeCols(): number[] {
    const cols: number[] = [];
    for (let c = this.range.c1; c <= this.range.c2; c++) cols.push(c);
    return cols;
  }

  /** Row indices covered by the current column/row range. */
  private rangeRows(): number[] {
    const rows: number[] = [];
    for (let r = this.range.r1; r <= this.range.r2; r++) rows.push(r);
    return rows;
  }

  private appendRow(): void {
    this.commitInput();
    this.model.body.push(this.model.header.map(() => ""));
    this.recompute();
    this.selectCell(this.model.body.length, this.active.col);
  }

  /* --------------------------------------------------------------- 网格 */

  /**
   * How many columns/rows to draw.
   *
   * The grid is no longer hard-capped at the visible canvas. It always covers
   * the viewport plus a fixed buffer past the visible edge, so a scroll reveals
   * grid rather than void and the buffer keeps growing as the user goes — the
   * grid feels endless. A finite `GROW_CAP` past the table's own size bounds the
   * DOM.
   *
   * The buffer is drawn at rest too, not just after the first scroll. A table
   * that fits the viewport has no overflow when covered exactly, so the scroll
   * container never scrolls and growth never starts — leaving the "endless grid"
   * dead for the common small table. Keeping the buffer always on guarantees
   * there is always something past the edge to scroll into.
   */
  private gridPlan(): { columns: number; rows: number } {
    const width = this.gridHost.clientWidth;
    const height = this.gridHost.clientHeight;
    const own = this.model.header.length;
    const real = this.model.body.length + 1;

    // `ceil`, not `floor`: rounding down leaves the grid a few pixels short of
    // the canvas, which is precisely the band this is trying to avoid.
    /* 视口与行号列都不随缩放改，所以这里解的是「未缩放的列宽取多少，own 列加上
       行号列正好铺满视口」——两边都先除以 zoom 换算回未缩放坐标再解。 */
    this.baseColumnWidth =
      this.request.fillMode === "stretch"
        ? Math.max(MIN_COLUMN, Math.ceil((width / this.zoom - GUTTER_WIDTH) / Math.max(1, own)))
        : PAD_COLUMN;

    /* 网格按真实尺寸布局，滚动量与格子尺寸是同一套单位，不需要再校正。 */
    const farX = this.gridHost.scrollLeft + width;
    const farY = this.gridHost.scrollTop + height;
    const coverCols = fitAcross(farX, this.gutterPx(), (col) => this.colPx(col));
    const coverRows = fitAcross(farY, this.headPx(), (row) => this.rowPx(row));
    const columns = Math.min(own + GROW_CAP, Math.max(own, coverCols) + H_BUFFER);
    const rows = Math.min(real + GROW_CAP, Math.max(real, coverRows) + V_BUFFER);
    this.renderedCols = columns;
    this.renderedRows = rows;
    return { columns, rows };
  }

  /**
   * Called on scroll: when the viewport nears the rendered edge, grow the grid
   * so there is always more to scroll into. Only re-renders on growth — sliding
   * back up keeps the cells already drawn instead of rebuilding the DOM on every
   * tick — and the growth is capped at `GROW_CAP` past the table so the DOM
   * cannot grow without bound.
   */
  private ensureBuffer(): void {
    const width = this.gridHost.clientWidth;
    const height = this.gridHost.clientHeight;
    if (width === 0 || height === 0) return;

    const own = this.model.header.length;
    const real = this.model.body.length + 1;
    const farX = this.gridHost.scrollLeft + width;
    const farY = this.gridHost.scrollTop + height;
    const coverCols = fitAcross(farX, this.gutterPx(), (col) => this.colPx(col));
    const coverRows = fitAcross(farY, this.headPx(), (row) => this.rowPx(row));
    const columns = Math.min(own + GROW_CAP, Math.max(own, coverCols) + H_BUFFER);
    const rows = Math.min(real + GROW_CAP, Math.max(real, coverRows) + V_BUFFER);
    if (columns > this.renderedCols || rows > this.renderedRows) {
      this.growGrid(columns, rows);
    }
  }

  /**
   * Grows the grid without rebuilding it. Called from `ensureBuffer` on scroll:
   * appending rows/columns (rather than `empty()`-ing and redrawing) keeps the
   * scroll position and, crucially, leaves the native scrollbar drag intact. A
   * full `renderGrid` would drop the sheet mid-drag, which snaps `scrollTop` to
   * 0 and makes the scrollbar thumb fight the pointer — the bar becomes
   * un-draggable. Growth only ever reaches past the table's own bounds, and
   * `gridPlan` caps how far, so every cell added here is filler.
   *
   * New rows are inserted before the overlay box so the selection rectangle and
   * cell editor stay stacked on top of the grid.
   */
  private growGrid(columns: number, rows: number): void {
    const sheet = this.sheetEl;
    if (!sheet) return;
    const headRow = sheet.querySelector<HTMLElement>(".mtk-sheet-row.is-head");
    const widenBy = columns - this.renderedCols;
    const lengthenBy = rows - this.renderedRows;
    if (widenBy <= 0 && lengthenBy <= 0) return;

    /* Extend the sticky header with the new column letters. They are filler,
       but a size is a thing that lives only in this dialog, so a column added
       to cover the canvas carries a resizer just as honestly as a real one. */
    if (headRow && widenBy > 0) {
      for (let col = this.renderedCols; col < columns; col += 1) {
        const filler = col >= this.model.header.length;
        const cell = this.headCell(
          "mtk-sheet-cell" + (filler ? " is-filler" : ""),
          columnLetter(col),
          { "data-head": "col", "data-hcol": String(col) }
        );
        cell.style.width = `${this.colPx(col)}px`;
        cell.appendChild(this.resizer("col", col));
        headRow.appendChild(cell);
      }
    }

    /* Widening: append filler cells to every row already drawn. The data rows
       are in document order, so the loop index is the row number. */
    if (widenBy > 0) {
      const dataRows = sheet.querySelectorAll<HTMLElement>(".mtk-sheet-row:not(.is-head)");
      dataRows.forEach((tr, rowIndex) => {
        for (let col = this.renderedCols; col < columns; col += 1) {
          const cell = h("div", {
            cls: "mtk-sheet-cell is-filler",
            attr: { "data-row": String(rowIndex), "data-col": String(col) },
          });
          cell.style.width = `${this.colPx(col)}px`;
          this.applyRowHeight(cell, rowIndex);
          tr.appendChild(cell);
        }
      });
    }

    /* Lengthening: append whole filler rows below the table. */
    if (lengthenBy > 0) {
      for (let row = this.renderedRows; row < rows; row += 1) {
        sheet.insertBefore(this.buildRow(row, columns), this.rangeBox ?? null);
      }
    }

    this.renderedCols = columns;
    this.renderedRows = rows;
    this.refreshSelection();
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
    const height = `${this.rowPx(row)}px`;
    el.style.height = height;
    el.style.lineHeight = height;
  }

  private renderGrid(): void {
    /* Keep the scroll position across the rebuild: `empty()` drops the sheet,
       and if the new content is momentarily shorter the browser would snap the
       viewport back to the top, which reads as "scroll resets on edit". */
    const prevTop = this.gridHost.scrollTop;
    const prevLeft = this.gridHost.scrollLeft;
    this.gridHost.empty();
    const plan = this.gridPlan();

    const sheet = h("div", { cls: "mtk-tbl-sheet" });
    this.sheetEl = sheet;
    /* 字号、内边距、边框这些归样式表管的值，靠这个变量一起缩放——见
       styles.css 里表格那一段的 `calc(... * var(--mtk-zoom, 1))`。 */
    sheet.style.setProperty("--mtk-zoom", String(this.zoom));

    const headRow = h("div", { cls: "mtk-sheet-row is-head" });
    const corner = this.headCell("mtk-sheet-cell mtk-sheet-gutter");
    corner.setAttribute("data-corner", "1");
    corner.title = "点击全选整张表";
    this.applyGutterSize(corner);
    headRow.appendChild(corner);
    for (let col = 0; col < plan.columns; col += 1) {
      const filler = col >= this.model.header.length;
      const cell = this.headCell(
        "mtk-sheet-cell" + (filler ? " is-filler" : ""),
        columnLetter(col),
        { "data-head": "col", "data-hcol": String(col) }
      );
      cell.style.width = `${this.colPx(col)}px`;
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
    this.gridHost.scrollTop = prevTop;
    this.gridHost.scrollLeft = prevLeft;
    this.updateZoomLabel();
    this.refreshSelection();
  }

  /**
   * 表头上的一个格子（列标或角上的空行号位）。
   *
   * 高度在 JS 里落值而不是交给 CSS：表头高只有 `HEAD_HEIGHT` 一个出处，若让
   * 样式表再写一遍同样的数字，改常量时两处就会悄悄走散。宽度不在这里给——
   * 列标按列宽走，行号列按 `gutterPx()` 走。
   */
  private headCell(cls: string, text?: string, attr?: Record<string, string>): HTMLElement {
    const cell = h("div", { cls, text, attr });
    const height = `${this.headPx()}px`;
    cell.style.height = height;
    cell.style.lineHeight = height;
    return cell;
  }

  /**
   * 行号列的实际宽度。
   *
   * `flex` 要一起写：样式表里那条 `flex: 0 0 42px` 决定的是 flex 主轴尺寸，
   * 只改 `width` 在 flex 行里根本不参与布局——这正是那种"值写对了但没生效"的坑。
   */
  private applyGutterSize(el: HTMLElement): void {
    const px = this.gutterPx();
    el.style.width = `${px}px`;
    el.style.flex = `0 0 ${px}px`;
  }

  private buildRow(row: number, columns: number): HTMLElement {
    const tr = h("div", { cls: "mtk-sheet-row" });
    /* A row number is filler under exactly the boundary its data cells use, so
       "the number below the table" and "the cell below the table" agree on where
       the table ends. Getting this wrong is invisible: the number once never
       carried the class, so the two boundaries sat a row apart. */
    const gutter = h("div", {
      cls:
        "mtk-sheet-cell mtk-sheet-gutter" +
        (row > this.model.body.length ? " is-filler" : ""),
      text: String(row + 1),
      attr: { "data-head": "row", "data-hrow": String(row) },
    });
    this.applyRowHeight(gutter, row);
    this.applyGutterSize(gutter);
    gutter.appendChild(this.resizer("row", row));
    tr.appendChild(gutter);

    const values = row === 0 ? this.model.header : this.model.body[row - 1];

    for (let col = 0; col < columns; col += 1) {
      const cell = h("div", {
        cls: "mtk-sheet-cell",
        attr: { "data-row": String(row), "data-col": String(col) },
      });
      cell.style.width = `${this.colPx(col)}px`;
      this.applyRowHeight(cell, row);

      /* Past the table's own columns the grid keeps going. Those cells exist to
         fill the canvas: they say "you can put more here" without being
         coordinates the table already claims. Clicking one does nothing;
         editing one (`onDoubleClick`) is what grows the table to include it. */
      const beyondColumns = col >= this.model.header.length;
      if (beyondColumns || (row >= 1 && values === undefined)) {
        cell.classList.add("is-filler");
        tr.appendChild(cell);
        continue;
      }

      const result = this.results[row]?.[col];
      if (result) {
        /* 列级对齐：原生语法（写进分隔行），内联覆盖 CSS 默认（表头居中 /
           数字右对齐）。仅非 default 时覆盖，保留默认外观。 */
        const align = this.model.align[col];
        if (align && align !== "default") cell.style.textAlign = align;

        /* 单元格颜色：从 raw 文本里的 <span style> 读回，直接上样式；
           显示文本用 span.inner，否则会把标签当字面量显示出来。
           公式单元格（`=` 开头）不是颜色 span，落到 else 显示计算值。 */
        const raw = this.rawAt(row, col);
        const span = readColorSpan(raw);
        if (span) {
          cell.textContent = span.inner;
          if (span.props.color) cell.style.color = span.props.color;
          const bg = span.props["background-color"];
          if (bg) cell.style.backgroundColor = bg;
        } else {
          cell.textContent = result.text;
        }

        if (row > 0 && this.numericColumn(col)) cell.classList.add("is-num");
        if (result.error) cell.classList.add("is-err");
        if (result.formula) {
          cell.classList.add("is-fx");
          /* Inline `ƒ` marker in front of the value, matching the reading view
             and the lightbox preview so a computed cell reads as computed in all
             three contexts. Inserted before the value text node. */
          cell.insertBefore(
            h("span", { cls: "mtk-fx-mark", text: "ƒ" }),
            cell.firstChild,
          );
        }
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

  /** The rectangle "a whole column", "a whole row" or "a single cell" covers.
      A column covers every row and a row covers every column, which is the
      whole reason a Shift-extended selection cannot be derived from two
      corner cells alone. */
  private extentBox(row: number, col: number, kind: AnchorKind): Box {
    if (kind === "col") return { r1: 0, c1: col, r2: this.model.body.length, c2: col };
    if (kind === "row") return { r1: row, c1: 0, r2: row, c2: this.model.header.length - 1 };
    return { r1: row, c1: col, r2: row, c2: col };
  }

  /** What the cell, letter or number under the pointer covers. */
  private hitBox(hit: Hit): Box {
    const kind: AnchorKind = hit.head ?? "cell";
    return this.extentBox(hit.row, hit.col, kind);
  }

  /** What the anchor covers — the fixed end a Shift-extended selection grows
      from, left exactly where the first press put it. */
  private anchorBox(): Box {
    return this.extentBox(this.anchor.row, this.anchor.col, this.anchorKind);
  }

  /** The smallest rectangle holding both. Shift says "from there to here",
      and once whole rows and columns are in play that is a union rather than
      a pair of corners. */
  private unionBox(a: Box, b: Box): Box {
    return {
      r1: Math.min(a.r1, b.r1),
      c1: Math.min(a.c1, b.c1),
      r2: Math.max(a.r2, b.r2),
      c2: Math.max(a.c2, b.c2),
    };
  }

  /** Repaints selection-dependent classes and re-places the overlay. Cheap:
      selection never changes the grid's shape, only how it is drawn. */
  private refreshSelection(): void {
    /* The corner handle reads as "all selected" while that state is on; it is
       the one cell that is not part of the data selection itself. */
    const cornerEl = this.sheetEl.querySelector<HTMLElement>(".mtk-sheet-cell.mtk-sheet-gutter[data-corner]");
    if (cornerEl) cornerEl.classList.toggle("is-all", this.selectAll);
    this.sheetEl.querySelectorAll<HTMLElement>(".mtk-sheet-cell[data-row]").forEach((cell) => {
      const row = Number(cell.getAttribute("data-row"));
      const col = Number(cell.getAttribute("data-col"));
      cell.classList.toggle("in-range", this.inRange(row, col));
      /* During whole-table selection there is no single active square, so the
         accent outline is dropped — the lit headers already say "everything". */
      cell.classList.toggle("is-selected", !this.selectAll && row === this.active.row && col === this.active.col);
    });
    /* Every letter and number the selection reaches lights up, not only the
       active one: after selecting four rows, one lit number answers a
       different question than the one being asked.

       The exception is Excel's, and it is read off the anchor rather than
       off the range: a selection started *from a column letter* covers
       every row by construction, and lighting the whole row-number strip
       beside it would say the opposite of what was clicked. Reading it off
       the range instead would misfire on an ordinary block drag that
       happens to reach the last row — a block selection, which Excel lights
       on both strips. */
    const quietNumbers = this.anchorKind === "col";
    const quietLetters = this.anchorKind === "row";
    this.sheetEl.querySelectorAll<HTMLElement>('[data-head="col"]').forEach((cell) => {
      const col = Number(cell.getAttribute("data-hcol"));
      cell.classList.toggle("is-hl", !quietLetters && col >= this.range.c1 && col <= this.range.c2);
    });
    this.sheetEl.querySelectorAll<HTMLElement>('[data-head="row"]').forEach((cell) => {
      const row = Number(cell.getAttribute("data-hrow"));
      cell.classList.toggle("is-hl", !quietNumbers && row >= this.range.r1 && row <= this.range.r2);
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
    this.selectAll = false;
    if (extend) {
      this.active = next;
      this.range = this.unionBox(this.anchorBox(), this.extentBox(next.row, next.col, "cell"));
    } else {
      this.anchor = next;
      this.anchorKind = "cell";
      this.active = next;
      this.setBox(next, next);
    }
    this.refreshSelection();
  }

  private selectCell(row: number, col: number): void {
    const next = this.clampCell(row, col);
    this.selectAll = false;
    this.anchor = next;
    this.anchorKind = "cell";
    this.active = next;
    this.setBox(next, next);
    this.refreshSelection();
  }

  /** Excel's "click the corner" whole-table selection: every letter, number
      and data cell lights up and the single active square is dropped. The
      anchor stays a plain cell (never "col"/"row") so both header strips are
      lit — which is exactly what "the whole sheet" should say. */
  private selectAllTable(): void {
    this.selectAll = true;
    this.anchor = { row: 1, col: 0 };
    this.anchorKind = "cell";
    this.active = { row: 1, col: 0 };
    this.range = {
      r1: 0,
      c1: 0,
      r2: this.model.body.length,
      c2: this.model.header.length - 1,
    };
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
    /* The corner cell crosses the row-number and column-letter strips and
       carries no coordinates of its own — it is the "select the whole table"
       handle, which is a thing apart from a header click. Claim it before the
       coordinate-based branches below, which would otherwise read it as
       nothing and return null. */
    if (cell.hasAttribute("data-corner")) {
      return { head: null, row: -1, col: -1, filler: false, corner: true };
    }
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

    /* The corner cell selects the whole table, ahead of everything else that
       reads this event — it is not a column letter, a row number or a cell,
       so it must be claimed first. */
    if (hit.corner) {
      this.selectAllTable();
      this.drag = null;
      event.preventDefault();
      return;
    }

    if (hit.head === "col") {
      if (hit.filler) {
        this.addColumn();
        event.preventDefault();
        return;
      }
      this.selectAll = false;
      this.commitInput();
      /* Shift keeps the anchor where it was and grows the selection to the
         letter just clicked; without it the letter *becomes* the anchor.
         That is the whole of Excel's column multi-select: press A,
         Shift-press C, then Shift-press B walks the far edge back while A
         stays put. */
      if (shift) {
        this.active = { row: this.active.row, col: hit.col };
        this.range = this.unionBox(this.anchorBox(), this.hitBox(hit));
      } else {
        this.anchor = { row: 1, col: hit.col };
        this.anchorKind = "col";
        this.active = { row: 1, col: hit.col };
        this.range = this.hitBox(hit);
      }
      /* Either way the press starts a drag, from the rectangle just settled
         on: pulling away from a Shift-press must keep growing that
         selection rather than replacing it. */
      this.drag = { mode: "cols", from: { ...this.range } };
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
      this.selectAll = false;
      this.commitInput();
      /* See the column branch: Shift grows from the anchor, a plain press
         moves the anchor to the number just clicked. */
      if (shift) {
        this.active = { row: hit.row, col: this.active.col };
        this.range = this.unionBox(this.anchorBox(), this.hitBox(hit));
      } else {
        this.anchor = { row: hit.row, col: 0 };
        this.anchorKind = "row";
        this.active = { row: hit.row, col: 0 };
        this.range = this.hitBox(hit);
      }
      this.drag = { mode: "rows", from: { ...this.range } };
      this.refreshSelection();
      event.preventDefault();
      return;
    }

    if (hit.filler) {
      /* Nothing here, on purpose.
       *
       * This used to grow the table to reach the cell that was clicked, which
       * meant a plain click past the edge quietly added a row or a column —
       * looking at the grid changed it. Growing now belongs to *entering edit
       * mode* (see `onDoubleClick`), so a click out here does nothing at all.
       * Nothing is also the honest answer: there is no cell to select yet, and
       * selecting one that does not exist would put an address in the formula
       * bar that the table cannot write back to. */
      event.preventDefault();
      return;
    }

    this.commitInput();
    if (shift) {
      this.selectAll = false;
      this.active = this.clampCell(hit.row, hit.col);
      this.range = this.unionBox(this.anchorBox(), this.hitBox(hit));
      this.refreshSelection();
    } else {
      this.selectCell(hit.row, hit.col);
    }
    /* Both roads end in a drag. With Shift the anchor was deliberately left
       where it was, so pulling away from the click grows the selection from
       *it* rather than from the cell under the finger — which is what a
       Shift-drag does in a spreadsheet. */
    this.drag = { mode: "cells" };
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
    if (!hit || hit.head) return;
    /* Editing an empty cell is what grows the table: the cell has to exist
       before there is anything to type into, and this is now the only click in
       the grid that adds a row or a column. `extendTo` reaches the pressed cell
       exactly, so a double-click just below the last row adds one row and one
       just right of the last column adds one column — the gesture stays as
       small as the click was. */
    if (hit.filler) {
      this.extendTo(hit.row, hit.col);
      this.recompute();
    }
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
      /* 指针走的是屏幕像素，而列宽是未缩放的：放大到 200% 时拖 100px 只该得到
         50px 的新宽度，所以位移先除以 zoom 再累加。 */
      const moved = (event.clientX - drag.startX) / this.zoom;
      const width = clamp(drag.startW + moved, MIN_COL_W, MAX_COL_W);
      if (width !== this.colWidth(drag.col)) this.setColWidth(drag.col, width);
      return;
    }
    if (drag.mode === "rowh") {
      const moved = (event.clientY - drag.startY) / this.zoom;
      const height = clamp(drag.startH + moved, MIN_ROW_H, MAX_ROW_H);
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
        this.range = this.unionBox(this.anchorBox(), this.hitBox(hit));
        this.refreshSelection();
        return;
      }
      /* Only the dragged axis moves: the other one was settled at press time
         (a column letter covers the whole height, and a Shift-press may have
         brought rows in from the anchor), so letting the pointer widen it
         would silently re-answer a question already answered. */
      case "cols": {
        if (hit.col < 0) return;
        this.range = {
          r1: drag.from.r1,
          c1: Math.min(drag.from.c1, hit.col),
          r2: drag.from.r2,
          c2: Math.max(drag.from.c2, hit.col),
        };
        this.refreshSelection();
        return;
      }
      case "rows": {
        if (hit.row < 0) return;
        this.range = {
          r1: Math.min(drag.from.r1, hit.row),
          c1: drag.from.c1,
          r2: Math.max(drag.from.r2, hit.row),
          c2: drag.from.c2,
        };
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

    /* Preserve an existing same-type multi-selection: if the right-clicked
       head already sits inside the current column/row range, leave the
       selection untouched so "delete these rows/columns" acts on all of them.
       Otherwise fall back to Excel's behaviour of selecting just that head
       first, so the menu always reflects what a click would target. */
    const inSelection =
      head === "col"
        ? this.anchorKind === "col" && index >= this.range.c1 && index <= this.range.c2
        : this.anchorKind === "row" && index >= this.range.r1 && index <= this.range.r2;
    if (!inSelection) {
      if (head === "col") {
        this.anchor = { row: 1, col: index };
        this.anchorKind = "col";
        this.active = { row: 1, col: index };
        this.range = { r1: 0, c1: index, r2: this.model.body.length, c2: index };
      } else {
        this.anchor = { row: index, col: 0 };
        this.anchorKind = "row";
        this.active = { row: index, col: 0 };
        this.range = { r1: index, c1: 0, r2: index, c2: this.model.header.length - 1 };
      }
      this.refreshSelection();
    }

    const menu = new Menu();
    if (head === "col") {
      const targets =
        this.anchorKind === "col" && index >= this.range.c1 && index <= this.range.c2
          ? this.rangeCols()
          : [index];
      menu.addItem((item) =>
        item
          .setTitle(t("table.col.insertBefore"))
          .setIcon("plus")
          .onClick(() => this.insertColumnBefore(index))
      );
      menu.addItem((item) => {
        const label =
          targets.length > 1 ? `${t("table.col.delete")} (${targets.length})` : t("table.col.delete");
        item.setTitle(label).setIcon("trash-2").onClick(() => this.deleteColumns(targets));
        /* A table with no columns is not a table: never delete them all. */
        if (targets.length >= this.model.header.length) item.setDisabled(true);
      });
      menu.addItem((item) =>
        item
          .setTitle(t("table.col.append"))
          .setIcon("plus")
          .onClick(() => this.appendColumn())
      );
    } else {
      const targets =
        this.anchorKind === "row" && index >= this.range.r1 && index <= this.range.r2
          ? this.rangeRows()
          : [index];
      menu.addItem((item) =>
        item
          .setTitle(t("table.row.insertBefore"))
          .setIcon("plus")
          .onClick(() => this.insertRowBefore(index))
      );
      menu.addItem((item) => {
        const label =
          targets.length > 1 ? `${t("table.row.delete")} (${targets.length})` : t("table.row.delete");
        item.setTitle(label).setIcon("trash-2").onClick(() => this.deleteRows(targets));
        /* Row 1 is the Markdown header row, and the table does not survive
           without it. */
        if (targets.includes(0)) item.setDisabled(true);
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
    this.anchorKind = "cell";
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
    /* Pasting past the edge grows the table, the same way editing an empty cell
       does: the clipboard is already a deliberate act on those coordinates, so
       it does not need a second gesture to say where it is going. */
    this.extendTo(startRow + rows.length - 1, startCol + width - 1);
    rows.forEach((line, i) => {
      line.split("\t").forEach((value, j) => this.writeCell(startRow + i, startCol + j, value));
    });

    this.anchor = { row: startRow, col: startCol };
    this.anchorKind = "cell";
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
    this.anchorKind = "cell";
    this.active = { row: from.r2, col: from.c2 };
    this.range = { ...from };
    this.recompute();
  }

  /* ----------------------------------------------------------- 扩表 */

  /** Grows the table until the cell at `row`/`col` is a real cell.
   *
   *  Called when an empty cell is *edited*, and never merely because one was
   *  clicked: the address the user is typing into has to exist before it can
   *  hold anything. */
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
