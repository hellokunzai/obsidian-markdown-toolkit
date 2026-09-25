/**
 * The text tools behind the toolbar's 文本工具 menu.
 *
 * Every tool is a plain `string -> string` function, so all fifteen can be
 * exercised without an editor, a vault or a DOM. The editor-facing half lives
 * in `features/text-tools.ts`; the catalog at the bottom of this file is the
 * single source of truth for the menu, the command registration and the
 * executor table, which is what keeps the three from drifting apart.
 *
 * Two conventions run through the whole file:
 *
 * 1. A tool that finds nothing to change returns its input **unchanged**
 *    rather than an empty string. Replacing a selection with "" would quietly
 *    delete the user's text, and "nothing matched" is not the same request as
 *    "delete everything". The caller compares against the input and decides
 *    what to say about it.
 * 2. Line-oriented tools never invent lines: they map, filter and join the
 *    lines they were given, so the result always differs from the input in the
 *    way the label promises and in no other way.
 */

/* ------------------------------------------------------------ 获取无语法文本 */

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const BLOCKQUOTE = /^\s*(?:>\s?)+/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const TASK_BOX = /^\[[ xX]\]\s+/;
/** A callout's `[!note]` / `[!warning]-` marker, left over once `>` is gone. */
const CALLOUT = /^\[![^\]]+\][+-]?\s*/;
const HR = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

/**
 * A Markdown table's `| --- | :--: |` row.
 *
 * Recognised by shape rather than by position, because a tool can be handed a
 * fragment that starts in the middle of a table: a row that opens with `|`,
 * carries nothing but `|`, `-`, `:` and spaces, and holds at least one dash is
 * an alignment row and never data.
 */
function isTableRule(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("-") && /^[\s|:-]+$/.test(trimmed);
}

/** Emphasis, code, links and inline HTML — the part of Markdown that sits inside a line. */
function stripInline(text: string): string {
  return (
    text
      // Images before links: `![alt](url)` would otherwise be read as a link.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Embeds before wikilinks, and aliases before plain wikilinks.
      .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
      .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`\n]*)`/g, "$1")
      // Longest markers first: `***x***` must not be eaten as `*` + `**`
      // inside, and `**x**` must not leave a stray pair of asterisks behind.
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      // An underscore only opens emphasis at a word boundary, so identifiers
      // like `some_long_name` survive.
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/==([^=]+)==/g, "$1")
      .replace(/<[^>\n]+>/g, "")
  );
}

/**
 * The text with its Markdown syntax taken off: what the note says rather than
 * how it says it.
 *
 * Handled: fenced code (the fence lines go, the code stays), headings,
 * blockquotes and callouts, list markers and task boxes, horizontal rules,
 * table pipes and alignment rows, and every inline marker listed above.
 * Escapes (`\*`) are deliberately *not* unescaped: that would turn a literal
 * asterisk into a marker for the next tool in the chain.
 */
export function stripMarkdown(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const mark = line.match(FENCE)?.[1];
    if (fence !== null) {
      // Inside a fence the content is literal, so only a closing marker is
      // syntax — and it has to be the same character *and* at least as long as
      // the one that opened it. A three-backtick line inside a four-backtick
      // fence is content, not a close; comparing the first character alone
      // would drop it and swallow the rest of the block.
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) {
        fence = null;
        continue;
      }
      out.push(line);
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (HR.test(line) || isTableRule(line)) continue;

    let kept = line.replace(HEADING, "").replace(BLOCKQUOTE, "").replace(CALLOUT, "");
    if (LIST_ITEM.test(kept)) kept = kept.replace(LIST_ITEM, "$1").replace(TASK_BOX, "");
    kept = stripInline(kept);

    // A table row: the pipes are syntax, the cells are content.
    if (/^\s*\|.*\|\s*$/.test(kept)) {
      kept = kept
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .join(" ");
    }
    out.push(kept);
  }
  return out.join("\n");
}

/* -------------------------------------------------------------- 全角转半角 */

/**
 * Full-width ASCII and the ideographic space, folded back to half-width.
 *
 * Only U+FF01–U+FF5E is touched, and it maps by a constant 0xFEE0 offset —
 * the block is a shifted copy of ASCII by construction. Everything else
 * (CJK punctuation such as 。、 and the corner brackets) is left alone: those
 * are not full-width variants of anything, and rewriting them would be
 * editorialising rather than folding.
 */
export function toHalfWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E\u3000]/g, (ch) =>
    ch === "\u3000" ? " " : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/* ----------------------------------------------------------------- 行操作 */

/**
 * One empty line after every line that has content, the last one included.
 *
 * Including the last is what makes the command do something when a single line
 * is selected — the case a user is most likely to be in when they reach for it.
 */
export function insertBlankLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.trim() !== "") out.push("");
  }
  return out.join("\n");
}

export function removeBlankLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/**
 * Sentence breaks: the full-width marks, their ASCII twins, and a full stop.
 *
 * A bare `.` is included because English sentences need it, but only where a
 * sentence can actually end — followed by whitespace or by nothing. Without
 * that lookahead `3.14` and `v1.2.3` would be torn apart, and a tool for
 * splitting prose would be unusable on anything containing a number.
 */
const SENTENCE_BREAK = /([。！？；!?;])[ \t]*|\.(?=[ \t]|$)[ \t]*/g;

/**
 * One sentence per line.
 *
 * Chinese prose is routinely written as a single run-on paragraph, and the
 * point of this is to make it listable; so the break set is the full-width
 * marks first and their ASCII twins second, and the mark stays at the end of
 * the sentence it belongs to rather than starting the next line.
 */
export function splitLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const broken = line.replace(SENTENCE_BREAK, (match, mark: string | undefined) =>
        mark ? `${mark}\n` : ".\n"
      );
      // Every break adds a newline, including the one after the final mark.
      // Taking that one back keeps a one-line selection one line plus breaks,
      // instead of silently growing a blank line at the end of the document.
      return broken.endsWith("\n") ? broken.slice(0, -1) : broken;
    })
    .join("\n");
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** A space between two words, nothing between two CJK characters. */
function joinSeparator(left: string, right: string): string {
  return CJK.test(left.slice(-1)) || CJK.test(right.slice(0, 1)) ? "" : " ";
}

/**
 * All the non-empty lines joined into one, with a separator only where the
 * boundary actually needs one.
 *
 * Joining Chinese with spaces inserts visible gaps that were never in the
 * text, and joining English without them welds words together; testing the
 * two characters either side of the seam gets both right.
 */
export function mergeLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reduce((acc, line) => (acc === "" ? line : acc + joinSeparator(acc, line) + line), "");
}

/**
 * First occurrence of each line wins; later duplicates go.
 *
 * Blank lines are deduplicated like any other line, which collapses a run of
 * them into one — the paragraph break survives, the padding does not.
 */
export function removeDuplicateLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

/* --------------------------------------------------------------- 文本处理 */

/** Blank lines are skipped: a prefix on an empty line is invisible junk. */
export function addAffix(text: string, prefix: string, suffix: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : `${prefix}${line}${suffix}`))
    .join("\n");
}

/** True when a numbering template can actually produce a number. */
export function hasNumberPlaceholder(template: string): boolean {
  return template.includes("{n}");
}

/**
 * Each non-blank line numbered, starting at `start`.
 *
 * The template carries the number so the same tool covers `1. `, `第 1 条` and
 * `1) `; `{n}` is the only marker, and `hasNumberPlaceholder` is what lets the
 * dialog refuse a template with no marker instead of quietly numbering nothing.
 */
export function addLineNumbers(text: string, start: number, template: string): string {
  let n = start;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const numbered = template.replace(/\{n\}/g, String(n));
      n += 1;
      return numbered + line;
    })
    .join("\n");
}

export function trimLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Runs of horizontal whitespace become a single space.
 *
 * Leading whitespace is left alone, unlike every other run: `- a` nested under
 * `  - a` is a different list item, so collapsing the indent would flatten the
 * structure this tool is most often run over.
 */
export function collapseSpaces(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "";
      return indent + line.slice(indent.length).replace(/[ \t]{2,}/g, " ");
    })
    .join("\n");
}

export function removeAllWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/* --------------------------------------------------------------- 高级工具 */

interface ListRow {
  level: number;
  text: string;
}

/** Indent width (tabs counted as four) turned into a dense 0-based level. */
function toRows(text: string): ListRow[] {
  const widths: number[] = [];
  const rows: ListRow[] = [];

  for (const line of text.split("\n")) {
    const match = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, "    ").length;

    let level = widths.indexOf(indent);
    if (level < 0) {
      widths.push(indent);
      widths.sort((a, b) => a - b);
      level = widths.indexOf(indent);
    }
    rows.push({ level, text: stripInline(match[2]).trim() });
  }
  return rows;
}

/**
 * An indented Markdown list laid out as a table: one row per leaf, and the
 * ancestors that led to it in the columns to its left.
 *
 * Only leaves emit a row. A branch exists to group its children, so giving it
 * a row of its own would duplicate the first column of every child and make
 * the table longer without adding information.
 */
export function listToTable(text: string, levelLabel: string): string {
  const rows = toRows(text);
  if (rows.length === 0) return text;

  const depth = rows.reduce((max, row) => Math.max(max, row.level), 0) + 1;
  const path: string[] = [];
  const body: string[][] = [];

  rows.forEach((row, index) => {
    path.length = row.level;
    path[row.level] = row.text;

    const next = rows[index + 1];
    const isLeaf = !next || next.level <= row.level;
    if (!isLeaf) return;

    const cells: string[] = [];
    for (let i = 0; i < depth; i += 1) cells.push(path[i] ?? "");
    body.push(cells);
  });

  const header = Array.from({ length: depth }, (_unused, i) => `${levelLabel} ${i + 1}`);
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

/**
 * The data rows of a Markdown table, cells already stripped of inline markup.
 *
 * The header goes with the alignment row: a Markdown header names the columns
 * rather than holding data, so turning `| 项目 | 说明 |` into a list node would
 * put a node in every branch that says nothing about the branch. Dropping it is
 * also what makes `tableToList(listToTable(x))` give `x` back.
 */
function parseTable(text: string): string[][] {
  const rows: string[][] = [];
  let ruleAt = -1;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (isTableRule(trimmed)) {
      if (ruleAt < 0) ruleAt = rows.length;
      continue;
    }
    rows.push(
      trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => stripInline(cell).trim())
    );
  }

  if (ruleAt > 0) rows.splice(ruleAt - 1, 1);
  return rows;
}

/**
 * The inverse of `listToTable`: a cell that repeats the row above is an
 * ancestor, a cell that differs starts a new branch at that depth.
 *
 * The comparison runs column by column and stops at the first difference, so
 * the depth of the new item is the index of that column — which is exactly the
 * indentation it needs. A row identical to the previous one adds nothing and
 * is skipped.
 */
export function tableToList(text: string): string {
  const rows = parseTable(text);
  if (rows.length === 0) return text;

  const out: string[] = [];
  let previous: string[] = [];

  for (const cells of rows) {
    // The first column that differs is the depth of the new item, which is
    // exactly the indentation it needs. A row that repeats the one above it
    // therefore differs nowhere: `level` reaches the end and the loop below
    // emits nothing, so duplicates collapse without a check of their own.
    let level = 0;
    while (level < cells.length && previous[level] === cells[level]) level += 1;

    for (let i = level; i < cells.length; i += 1) {
      if (cells[i] === "") continue;
      out.push(`${"  ".repeat(i)}- ${cells[i]}`);
    }
    previous = cells;
  }

  return out.length === 0 ? text : out.join("\n");
}

/**
 * Everything between each `start` … `end` pair, one match per line.
 *
 * The markers themselves are dropped, and scanning resumes after the closing
 * one rather than after the opening one, so a pair inside a pair does not
 * swallow the rest of the text: `[a[b]c]` with `[`/`]` yields `a[b`, and the
 * trailing `c]` is left where it was. No match at all returns the input
 * untouched — a tool that wiped the selection when the user's brackets were
 * not there would be the worst possible failure for this one.
 */
export function extractBetween(text: string, start: string, end: string): string {
  if (start === "" || end === "") return text;

  const out: string[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf(start, index);
    if (open < 0) break;
    const close = text.indexOf(end, open + start.length);
    if (close < 0) break;
    out.push(text.slice(open + start.length, close));
    index = close + end.length;
  }
  return out.length === 0 ? text : out.join("\n");
}

/* ----------------------------------------------------------------- 目录表 */

export interface TextToolEntry {
  /** Suffix of the command id: `text-tool-<slug>`. */
  readonly slug: string;
  /** Icon name resolved through Obsidian's icon set. */
  readonly icon: string;
  /** Complete i18n key for the command name and the menu title. */
  readonly nameKey: string;
  /** Set on the first entry of a menu section; the key names that section. */
  readonly sectionKey?: string;
}

/**
 * The fifteen tools, in the order the menu shows them.
 *
 * `sectionKey` marks the entry that *starts* a section rather than living on
 * the heading, because the heading is not a tool: keeping it out of the data
 * means the menu builder, the command registration and the settings list all
 * iterate one list of things that actually do something.
 */
const CATALOG = [
  { slug: "plain", icon: "file-text", nameKey: "textTool.plain.name" },
  { slug: "half-width", icon: "at-sign", nameKey: "textTool.halfWidth.name" },

  {
    slug: "blank-insert",
    icon: "separator-horizontal",
    nameKey: "textTool.blankInsert.name",
    sectionKey: "textTool.section.lines",
  },
  { slug: "blank-remove", icon: "fold-vertical", nameKey: "textTool.blankRemove.name" },
  { slug: "split", icon: "split", nameKey: "textTool.split.name" },
  { slug: "merge", icon: "merge", nameKey: "textTool.merge.name" },
  { slug: "dedupe", icon: "filter", nameKey: "textTool.dedupe.name" },

  {
    slug: "affix",
    icon: "list-plus",
    nameKey: "textTool.affix.name",
    sectionKey: "textTool.section.process",
  },
  { slug: "line-number", icon: "list-ordered", nameKey: "textTool.lineNumber.name" },
  { slug: "trim", icon: "scissors", nameKey: "textTool.trim.name" },
  { slug: "collapse", icon: "fold-horizontal", nameKey: "textTool.collapse.name" },
  { slug: "strip-space", icon: "eraser", nameKey: "textTool.stripSpace.name" },

  {
    slug: "list-table",
    icon: "table",
    nameKey: "textTool.listTable.name",
    sectionKey: "textTool.section.advanced",
  },
  { slug: "table-list", icon: "list-tree", nameKey: "textTool.tableList.name" },
  { slug: "extract", icon: "brackets", nameKey: "textTool.extract.name" },
] as const satisfies readonly TextToolEntry[];

/** The union of every slug, so an executor table can be required to be total. */
export type TextToolSlug = (typeof CATALOG)[number]["slug"];

/** The catalog with its literal types intact; the menu and the commands share it. */
export const TEXT_TOOLS = CATALOG;

/** True for the entry that opens a menu section. */
export function startsSection(entry: TextToolEntry): boolean {
  return typeof entry.sectionKey === "string" && entry.sectionKey.length > 0;
}

/** Prefix of the command id for every tool; Obsidian adds the `markdown-toolkit:` part. */
export const TEXT_TOOL_COMMAND_PREFIX = "text-tool-";

/**
 * The id a tool is registered under, and the one the menu points at.
 *
 * Defined here rather than next to the command registration so the toolbar's
 * default list can build its menu without importing from `features/`: the
 * data model stays free of the editor side, exactly like the rest of `core/`.
 */
export function textToolCommandId(slug: TextToolSlug): string {
  return `markdown-toolkit:${TEXT_TOOL_COMMAND_PREFIX}${slug}`;
}
