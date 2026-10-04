/**
 * The formula engine behind a Markdown table's computed cells.
 *
 * A table stays a plain Markdown table — nothing here adds a syntax of its own.
 * What it adds is the *reading* of one: a cell whose text starts with `=` is
 * treated as a formula, everything else is literal, and the answer is what the
 * renderer shows instead of the formula itself. The source keeps the formula.
 *
 * Conventions, and why:
 *
 * 1. **Coordinates are A1, and row 1 is the header.** Column A is the first
 *    column, row 2 is the first data row. Saying "the header is row 1" means a
 *    formula written against a table reads the same as the table looks, and it
 *    means adding a data row never renumbers anything the user has written.
 * 2. **Errors are values, not exceptions.** A formula over a range that does
 *    not exist is a normal thing to type, and the answer to it is a cell that
 *    says `#REF!` — not a thrown error that takes the whole render down.
 * 3. **No `eval`, no `new Function`.** This plugin ships to the community
 *    store, where building source out of note text and running it is a review
 *    blocker — and rightly so: the note is the user's, and a vault is not a
 *    place to execute from. The grammar is four operators wide, so it is
 *    written out instead (see `evalArithmetic`).
 * 4. **Nothing in this file touches the DOM.** Everything is plain data in,
 *    plain data out, so the whole engine is exercised without an editor.
 */

/* ------------------------------------------------------------------ 类型 */

/** How a column is aligned, as written in the `| :---: |` row. */
export type TableAlign = "left" | "center" | "right" | "default";

/** The error codes a cell can show. Kept small and Excel-shaped on purpose. */
export type CellError = "#REF!" | "#CYCLE!" | "#NAME?" | "#VALUE!";

/** A parsed Markdown table. Cells keep their source text, formulas included. */
export interface TableModel {
  /** The first row's cells, always literal. */
  header: string[];
  /** The remaining rows, in file order. */
  body: string[][];
  /** One entry per column, taken from the alignment row. */
  align: TableAlign[];
}

/** What one cell resolves to. */
export interface CellResult {
  /** The cell exactly as it is written in the note. */
  raw: string;
  /** What to show: the computed value, or the literal text. */
  text: string;
  /** True when `raw` starts with `=`. */
  formula: boolean;
  /** The value when the cell resolved to a number, for the caller's own use. */
  num?: number;
  /** Set when the formula could not be evaluated. `text` then repeats it. */
  error?: CellError;
}

/* ------------------------------------------------------------ 坐标与格式 */

/**
 * The A1 column name for a zero-based index: 0 → `A`, 25 → `Z`, 26 → `AA`.
 *
 * Bijective base 26 rather than plain base 26 — there is no zero digit, which
 * is why the index is incremented before the first division instead of after.
 */
export function columnLetter(index: number): string {
  let out = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The inverse of `columnLetter`. Returns -1 for anything that is not a name. */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]+$/.test(letters)) return -1;
  let out = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i += 1) {
    out = out * 26 + (up.charCodeAt(i) - 64);
  }
  return out - 1;
}

/** The A1 reference of a zero-based cell. Row 0 is A1's row 1. */
export function cellRef(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

/**
 * A number as the renderer shows it: thousands separated, at most two decimals.
 *
 * The separators are added *here* rather than stored, which is the whole point
 * of computing at render time: `12000` stays `12000` in the note and reads as
 * `12,000` on screen. Two decimals is the cap because money is the case this
 * exists for and binary floating point runs out of honesty well before then.
 */
export function formatNumber(value: number): string {
  if (!isFinite(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  const [whole, fraction] = String(rounded).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/* -------------------------------------------------------------- 表格解析 */

/**
 * True for the `| --- | :--: |` row.
 *
 * Recognised by shape rather than by position: every cell has to be dashes with
 * optional alignment colons, and there has to be at least one dash somewhere —
 * a row of bare `|` characters is a one-cell row of empty text, not a rule.
 */
export function isAlignmentRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = splitRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/**
 * A table row split into cells, keeping escaped pipes (`\|`) inside cells.
 *
 * A plain `split("|")` is wrong the moment a cell contains a pipe, which is
 * common in a column of code or of Markdown. The escape is preserved rather
 * than unwrapped: this parser's job is to report what is written, and undoing
 * the escape here would make the round trip through `serializeTable` lossy.
 */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "\\|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function alignOf(cell: string): TableAlign {
  const left = cell.trim().startsWith(":");
  const right = cell.trim().endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "default";
}

/**
 * Reads a Markdown table out of `markdown`, or returns null when there is none.
 *
 * Null rather than a throw, because "this text is not a table" is the ordinary
 * case for every caller: the post processor runs over every element in a note,
 * and a parser that shouted about paragraphs would have to be wrapped in a
 * try/catch by everyone who used it.
 *
 * The alignment row is required. A lone `| a | b |` line is not a table as far
 * as Markdown is concerned, and accepting one here would put the renderer out
 * of step with Obsidian about what it is looking at.
 */
export function parseTable(markdown: string): TableModel | null {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const rows: string[][] = [];
  let alignAt = -1;

  for (const line of lines) {
    if (!line.startsWith("|")) {
      // A table is a run of consecutive rows; anything else ends it.
      if (rows.length > 0) break;
      continue;
    }
    if (isAlignmentRow(line)) {
      if (alignAt < 0) alignAt = rows.length;
      continue;
    }
    rows.push(splitRow(line));
  }

  // The rule has to sit directly under the header: anywhere else it is just a
  // row of dashes, and treating it as a rule would drop a row of real text.
  if (rows.length < 2 || alignAt !== 1) return null;

  const header = rows[0];
  const ruleCells = splitRow(lines.find((line) => isAlignmentRow(line)) ?? "");
  const align: TableAlign[] = header.map((_cell, i) => alignOf(ruleCells[i] ?? "---"));

  return { header, body: rows.slice(1), align };
}

/**
 * The table written back out: one cell per column, padded so the pipes line up.
 *
 * Padding is by *display* width, not by character count — a CJK glyph is two
 * columns wide in a monospace font, and counting it as one is what makes a
 * Chinese table's source look ragged however carefully it was written.
 */
export function serializeTable(model: TableModel): string {
  const rows = [model.header, ...model.body];
  const widths: number[] = [];
  rows.forEach((row) => {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  });

  /** One row, every cell padded to its column's width. */
  const padded = (row: readonly string[]): string =>
    `| ${model.header
      .map((_unused, i) => {
        const text = row[i] ?? "";
        return text + " ".repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(text)));
      })
      .join(" | ")} |`;

  /**
   * The rule row, built from the same widths so its pipes land where the rest
   * of the table's do.
   *
   * Padded with dashes rather than spaces, because a colon that has been pushed
   * off the end of its cell stops being an alignment colon and starts being
   * text. `Math.max(3, …)` is the floor Markdown needs to read a cell as a
   * rule at all.
   */
  const rule =
    `| ${model.header
      .map((_unused, i) => {
        const width = Math.max(3, widths[i] ?? 3);
        switch (model.align[i] ?? "default") {
          case "center":
            return `:${"-".repeat(Math.max(1, width - 2))}:`;
          case "right":
            return `${"-".repeat(Math.max(2, width - 1))}:`;
          case "left":
            return `:${"-".repeat(Math.max(2, width - 1))}`;
          default:
            return "-".repeat(width);
        }
      })
      .join(" | ")} |`;

  return [padded(model.header), rule, ...model.body.map(padded)].join("\n");
}

/** Terminal columns a string occupies: a CJK glyph is two, everything else one. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/* ---------------------------------------------------------------- 求值 */

/** A resolved value, before it is turned into display text. */
type Value =
  | { kind: "num"; num: number }
  | { kind: "text"; text: string }
  | { kind: "err"; code: CellError };

const AGGREGATES = ["sum", "avg", "count", "max", "min"] as const;
type Aggregate = (typeof AGGREGATES)[number];

const RANGE = /^([A-Za-z]+)(\d+)\s*:\s*([A-Za-z]+)(\d+)$/;
const CALL = /^([A-Za-z]+)\s*\((.*)\)$/;

/**
 * The table as a formula sees it.
 *
 * The bounds are passed in rather than letting `at` answer `#REF!` for anything
 * outside them. That is what lets a range tell "the table is shorter than I
 * assumed" (clamp it, fine) apart from "that column does not exist" (a typo
 * either way). Without the bounds the two are the same error, and
 * `=sum(A2:A99)` on a five-row table would report `#REF!` instead of a total.
 */
interface Sheet {
  readonly rows: number;
  readonly cols: number;
  at(row: number, col: number): Value;
}

/**
 * Every cell of the table, evaluated.
 *
 * Index 0 is the header row, so the result lines up with `[model.header,
 * ...model.body]` and a caller can walk both with one index. Header cells are
 * always literal — a formula in a header would be naming a column by a value
 * that depends on the column.
 */
export function evaluateTable(model: TableModel): CellResult[][] {
  const all = [model.header, ...model.body];
  const memo = new Map<string, CellResult>();
  const visiting = new Set<string>();

  const at = (row: number, col: number): Value => {
    if (row < 0 || row >= all.length || col < 0 || col >= model.header.length) {
      return { kind: "err", code: "#REF!" };
    }
    const raw = all[row][col] ?? "";
    if (row === 0 || !raw.startsWith("=")) {
      // A literal that looks like a number *is* one, so `=B2-C2` works over a
      // column of plain figures without the user having to write `=VALUE(B2)`.
      const num = toNumber(raw);
      return num === null ? { kind: "text", text: raw } : { kind: "num", num };
    }

    const key = cellRef(row, col);
    const cached = memo.get(key);
    if (cached) return toValue(cached);
    if (visiting.has(key)) return { kind: "err", code: "#CYCLE!" };

    visiting.add(key);
    const value = evalFormula(raw.slice(1), sheet);
    visiting.delete(key);

    memo.set(key, toResult(raw, value));
    return value;
  };

  const sheet: Sheet = { rows: all.length, cols: model.header.length, at };

  return all.map((row, r) =>
    row.map((raw, c) => {
      if (r === 0 || !raw.startsWith("=")) return toResult(raw, at(r, c));
      at(r, c);
      return memo.get(cellRef(r, c)) ?? toResult(raw, { kind: "text", text: raw });
    })
  );
}

function toValue(result: CellResult): Value {
  if (result.error) return { kind: "err", code: result.error };
  if (typeof result.num === "number") return { kind: "num", num: result.num };
  return { kind: "text", text: result.text };
}

function toResult(raw: string, value: Value): CellResult {
  if (value.kind === "err") return { raw, text: value.code, formula: raw.startsWith("="), error: value.code };
  if (value.kind === "num") {
    return { raw, text: formatNumber(value.num), formula: raw.startsWith("="), num: value.num };
  }
  return { raw, text: value.text, formula: raw.startsWith("=") };
}

/** A literal parsed as a number, or null when it is text. */
function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return isFinite(num) ? num : null;
}

function evalFormula(expression: string, sheet: Sheet): Value {
  const call = expression.trim().match(CALL);
  if (call) {
    const name = call[1].toLowerCase();
    if (!(AGGREGATES as readonly string[]).includes(name)) return { kind: "err", code: "#NAME?" };
    return evalAggregate(name as Aggregate, call[2].trim(), sheet);
  }

  // Cell references are replaced by their values, and whatever is left has to
  // be arithmetic. A reference that resolves to an error takes the cell with
  // it: `=B2-C2` with a `#REF!` in B2 is a `#REF!`, not a `#VALUE!`.
  //
  // Failures are collected in an array rather than a `let` because TypeScript
  // narrows a closure-assigned `let` to its initial type (`null`) and then
  // refuses to read it back outside the callback.
  const failures: CellError[] = [];
  const substituted = expression.replace(/\b([A-Za-z]+)(\d+)\b/g, (_match, letters: string, digits: string) => {
    const value = sheet.at(Number.parseInt(digits, 10) - 1, columnIndex(letters));
    if (value.kind === "err") {
      failures.push(value.code);
      return "0";
    }
    if (value.kind === "num") return `(${value.num})`;
    failures.push("#VALUE!");
    return "0";
  });
  if (failures.length > 0) return { kind: "err", code: failures[0] };

  const num = evalArithmetic(substituted);
  return num === null ? { kind: "err", code: "#NAME?" } : { kind: "num", num };
}

function evalAggregate(name: Aggregate, range: string, sheet: Sheet): Value {
  const match = range.match(RANGE);
  if (!match) return { kind: "err", code: "#NAME?" };

  const colFrom = columnIndex(match[1]);
  const rowFrom = Number.parseInt(match[2], 10) - 1;
  const colTo = columnIndex(match[3]);
  const rowTo = Number.parseInt(match[4], 10) - 1;
  if (colFrom < 0 || colTo < 0) return { kind: "err", code: "#REF!" };
  if (colFrom >= sheet.cols || colTo >= sheet.cols) return { kind: "err", code: "#REF!" };

  // Rows are clamped, columns are not. Growing a table downwards is the normal
  // direction, so a range that runs past the last row has to keep working —
  // that is the whole reason `=sum(B2:B99)` is a reasonable thing to write. A
  // range that names a column the table does not have is a typo either way, and
  // clamping it would silently total the wrong column.
  const loRow = Math.max(0, Math.min(rowFrom, rowTo));
  const hiRow = Math.min(sheet.rows - 1, Math.max(rowFrom, rowTo));
  if (hiRow < loRow) return { kind: "err", code: "#REF!" };

  const numbers: number[] = [];
  let filled = 0;
  for (let row = loRow; row <= hiRow; row += 1) {
    for (let col = Math.min(colFrom, colTo); col <= Math.max(colFrom, colTo); col += 1) {
      const value = sheet.at(row, col);
      if (value.kind === "err") return value;
      if (value.kind === "num") {
        numbers.push(value.num);
        filled += 1;
      } else if (value.text !== "") {
        filled += 1;
      }
    }
  }

  // `count` is COUNTA: it counts cells with anything in them, text included,
  // which is what "how many rows did I enter" means in practice.
  if (name === "count") return { kind: "num", num: filled };
  if (numbers.length === 0) return { kind: "text", text: "—" };

  const total = numbers.reduce((a, b) => a + b, 0);
  switch (name) {
    case "sum":
      return { kind: "num", num: total };
    case "avg":
      return { kind: "num", num: Math.round((total / numbers.length) * 100) / 100 };
    case "max":
      return { kind: "num", num: Math.max(...numbers) };
    default:
      return { kind: "num", num: Math.min(...numbers) };
  }
}

/**
 * A hand-written evaluator for `+ - * /`, unary minus and parentheses.
 *
 * Recursive descent, one function per precedence level, which is the smallest
 * shape that reads as the grammar it implements. Anything left over at the end
 * — a stray word, an unclosed bracket — makes the whole thing null so the
 * caller can report `#NAME?` rather than a number that only looks plausible.
 */
export function evalArithmetic(source: string): number | null {
  let at = 0;

  const skip = (): void => {
    while (at < source.length && /\s/.test(source[at])) at += 1;
  };

  const expr = (): number | null => {
    let left = term();
    if (left === null) return null;
    for (;;) {
      skip();
      const op = source[at];
      if (op !== "+" && op !== "-") return left;
      at += 1;
      const right = term();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  };

  const term = (): number | null => {
    let left = factor();
    if (left === null) return null;
    for (;;) {
      skip();
      const op = source[at];
      if (op !== "*" && op !== "/") return left;
      at += 1;
      const right = factor();
      if (right === null) return null;
      left = op === "*" ? left * right : left / right;
    }
  };

  const factor = (): number | null => {
    skip();
    if (source[at] === "-") {
      at += 1;
      const value = factor();
      return value === null ? null : -value;
    }
    if (source[at] === "+") {
      at += 1;
      return factor();
    }
    return primary();
  };

  const primary = (): number | null => {
    skip();
    if (source[at] === "(") {
      at += 1;
      const value = expr();
      skip();
      if (source[at] !== ")") return null;
      at += 1;
      return value;
    }
    const start = at;
    while (at < source.length && /[0-9.]/.test(source[at])) at += 1;
    if (at === start) return null;
    const num = Number(source.slice(start, at));
    return isFinite(num) ? num : null;
  };

  const value = expr();
  skip();
  if (value === null || at !== source.length) return null;
  return isFinite(value) ? value : null;
}

/* --------------------------------------------------------------- 概述 */

/** How many cells in the model hold a formula. Used for the block's badge. */
export function countFormulas(model: TableModel): number {
  let total = 0;
  for (const row of model.body) {
    for (const cell of row) {
      if (cell.startsWith("=")) total += 1;
    }
  }
  return total;
}

/** True when the table has nothing computed in it — a plain Markdown table. */
export function hasFormulas(model: TableModel): boolean {
  return countFormulas(model) > 0;
}

/**
 * The first table in `section` replaced by `markdown`, or null when it holds none.
 *
 * The unit a post processor can hand back is a *section*, not a table, and a
 * section is routinely a paragraph, a table and another paragraph. So the write
 * back has to find the table's own lines and leave everything else exactly
 * where it was — replacing the whole section is how a save quietly deletes the
 * sentence that introduced the table.
 *
 * "The table" is the first run of lines that begin with `|`, which is the same
 * shape the renderer keys off. A second table later in the same section is left
 * alone; this is only ever asked to rewrite the one it was opened on.
 */
export function replaceTableInText(section: string, markdown: string): string | null {
  const lines = section.split(/\r?\n/);
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("|")) {
      if (start < 0) start = i;
      end = i;
      continue;
    }
    if (start >= 0) break;
  }
  if (start < 0) return null;

  return [
    ...lines.slice(0, start),
    ...markdown.split("\n"),
    ...lines.slice(end + 1),
  ].join("\n");
}
