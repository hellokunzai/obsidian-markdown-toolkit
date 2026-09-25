/**
 * Text alignment, which Markdown has no syntax for.
 *
 * The only way to align anything in a note is to write HTML, and the *shape* of
 * that HTML decides what survives. A block-level tag (`<p align=…>`, `<div>`,
 * `<center>`) starts an HTML block, and the Markdown parser treats everything
 * inside an HTML block as literal text — so a centred line containing `**bold**`
 * would come out showing asterisks. An *inline* tag does not: `<span>` is not in
 * CommonMark's list of block tags, so the line stays a paragraph and its inline
 * Markdown is still parsed. `display:block` is what then turns that span into a
 * box that `text-align` can act on.
 *
 * Three conventions, all inherited from the rest of the plugin:
 *
 * 1. The work is a plain `string -> string` function over the lines to be
 *    aligned, so every rule below can be exercised without an editor.
 * 2. Pressing the same alignment again takes it off, and pressing a different
 *    one *replaces* the tag rather than nesting a second span inside the first.
 *    The reference plugin nests, which is how a note ends up three tags deep
 *    around one paragraph with no way back except editing the source by hand.
 * 3. A target with nothing in it is `null` rather than an empty span — wrapping
 *    nothing would leave `<span …></span>` in the document, which is neither
 *    what the user asked for nor something they can see.
 */

/* ---------------------------------------------------------------- wrappers */

/**
 * The four alignments, in the order the menu shows them.
 *
 * Which is the reference plugin's order, and the order its menu was screenshotted
 * in: justify first, then left, centre and right. Odd as it looks, matching it
 * means the two plugins' menus read the same, and the settings page can reorder
 * these rows like any others.
 */
const CATALOG = [
  { slug: "justify", icon: "align-justify", nameKey: "textAlign.justify.name" },
  { slug: "left", icon: "align-left", nameKey: "textAlign.left.name" },
  { slug: "center", icon: "align-center", nameKey: "textAlign.center.name" },
  { slug: "right", icon: "align-right", nameKey: "textAlign.right.name" },
] as const satisfies readonly AlignEntry[];

export interface AlignEntry {
  /** Suffix of the command id: `text-align-<slug>`. */
  readonly slug: AlignKind;
  /** Icon name resolved through Obsidian's icon set. */
  readonly icon: string;
  /** Complete i18n key for the command name and the menu title. */
  readonly nameKey: string;
}

export type AlignKind = "left" | "center" | "right" | "justify";

/** The catalog with its literal types intact; the menu and the commands share it. */
export const ALIGN_TOOLS = CATALOG;

/** Every alignment, for a caller that has to try each one without its icon. */
export const ALIGN_KINDS: readonly AlignKind[] = ALIGN_TOOLS.map((entry) => entry.slug);

const OPEN_PREFIX = '<span style="display:block;text-align:';
const OPEN_SUFFIX = '">';
const CLOSE = "</span>";

/** The pair of tags one alignment writes. */
function wrapper(kind: AlignKind): { open: string; close: string } {
  return { open: `${OPEN_PREFIX}${kind}${OPEN_SUFFIX}`, close: CLOSE };
}

export interface AlignResult {
  /** What the block should become. */
  readonly text: string;
  /**
   * How far the block's own text moves, in characters.
   *
   * Everything this module writes sits either before the content (the opening
   * tag, and the newline that puts it on a line of its own) or after it (the
   * closing tag, and its newline), so a character *inside* the block moves by
   * exactly this much — line breaks included. That is what lets the caret be
   * restored by offset alone, with no line arithmetic to get wrong when a
   * paragraph grows a line at the top. Without it the caret would land a few
   * characters off every time the user aligned a paragraph by pressing with
   * nothing selected.
   */
  readonly delta: number;
}

/** The text wrapped in `kind`, one line stays inline, several get their own lines. */
function wrapBlock(text: string, kind: AlignKind): string {
  const { open, close } = wrapper(kind);
  const lines = text.split("\n");
  if (lines.length === 1) return `${open}${text}${close}`;
  return [open, ...lines, close].join("\n");
}

/**
 * The alignment a block is already wrapped in, with the tags taken off.
 *
 * Matched on the whole opening tag rather than on `align:` anywhere in it, so a
 * span someone wrote by hand for another purpose (`text-align:right` on a
 * quotation, say) is not mistaken for this plugin's own wrapper unless it is
 * byte-for-byte the tag this module writes.
 */
function readWrapper(block: string): { kind: AlignKind; inner: string } | null {
  for (const entry of ALIGN_TOOLS) {
    const { open, close } = wrapper(entry.slug);
    if (block.length < open.length + close.length) continue;
    if (!block.startsWith(open) || !block.endsWith(close)) continue;
    const inner = block.slice(open.length, block.length - close.length);
    return { kind: entry.slug, inner: inner.replace(/^\n+|\n+$/g, "") };
  }
  return null;
}

/**
 * The block with `kind` applied: wrapped, switched, or unwrapped again.
 *
 * The three cases are the three things a user can mean by pressing one of these
 * buttons, and they are decided in that order because "already wrapped" is the
 * only one where the existing tag matters.
 */
export function applyAlignment(block: string, kind: AlignKind): AlignResult {
  const existing = readWrapper(block);
  if (!existing) {
    // Nothing to strip: the whole block is content, so it moves by exactly the
    // room the new opening tag takes up.
    return { text: wrapBlock(block, kind), delta: contentStart(kind, block) };
  }
  // Where the content already sat, from the tag that is about to be rewritten.
  const before = contentOffset(existing.kind, block);
  if (existing.kind === kind) {
    return { text: existing.inner, delta: -before };
  }
  return {
    text: wrapBlock(existing.inner, kind),
    delta: contentStart(kind, existing.inner) - before,
  };
}

/** Where the content starts in a block this module is about to write. */
function contentStart(kind: AlignKind, text: string): number {
  return wrapper(kind).open.length + (text.includes("\n") ? 1 : 0);
}

/**
 * Where the content starts in a block that is already wrapped.
 *
 * Read off the block rather than assumed from the shape this module would
 * write today: a paragraph wrapped while it was one line and then edited into
 * three still has its first line on the tag's own line, and the arithmetic has
 * to agree with what is actually in the document or the caret lands a
 * character out.
 */
function contentOffset(kind: AlignKind, block: string): number {
  const open = wrapper(kind).open;
  return open.length + (block.startsWith(`${open}\n`) ? 1 : 0);
}

/* ------------------------------------------------------------ the target */

/** A line/column pair, structurally an `EditorPosition` but declared here so
 *  `core/` stays free of the editor types. */
export interface AlignPos {
  readonly line: number;
  readonly ch: number;
}

export interface AlignRequest {
  /** The selection, or `null` when nothing is selected. */
  readonly selection: { readonly from: AlignPos; readonly to: AlignPos } | null;
  /** Where the caret is — what an alignment with no selection acts on. */
  readonly caret: AlignPos;
}

/** Just enough of an editor to work out which lines are in play. */
export interface LineReader {
  readonly count: number;
  read(index: number): string;
}

export interface AlignTarget {
  readonly fromLine: number;
  readonly toLine: number;
  /** The lines joined back up: the text that gets wrapped. */
  readonly text: string;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * The lines an alignment covers.
 *
 * With a selection: the selected lines, minus a last line the selection only
 * touches at column 0 — `Shift+Down` leaves the caret there, and aligning the
 * line *below* what was selected is never what was meant — and minus blank
 * lines at either end, which are spacing rather than content.
 *
 * With no selection: the paragraph around the caret, meaning the run of
 * non-blank lines above and below it. That is what "centre this" does in a word
 * processor, and it is the case a toolbar button is most often pressed in — a
 * title being written, with nothing selected. A caret on a blank line belongs
 * to no paragraph, so the answer is `null` and the caller says so instead of
 * wrapping nothing.
 */
export function alignTarget(lines: LineReader, request: AlignRequest): AlignTarget | null {
  if (lines.count === 0) return null;
  const last = lines.count - 1;
  const blank = (index: number): boolean => lines.read(index).trim() === "";

  if (!request.selection) {
    const caretLine = clamp(request.caret.line, 0, last);
    if (blank(caretLine)) return null;
    let from = caretLine;
    while (from > 0 && !blank(from - 1)) from -= 1;
    let to = caretLine;
    while (to < last && !blank(to + 1)) to += 1;
    return { fromLine: from, toLine: to, text: join(lines, from, to) };
  }

  const from0 = clamp(request.selection.from.line, 0, last);
  let to = clamp(request.selection.to.line, 0, last);
  if (to > from0 && request.selection.to.ch === 0) to -= 1;

  let from = from0;
  while (from <= to && blank(from)) from += 1;
  while (to >= from && blank(to)) to -= 1;
  if (from > to) return null;
  return { fromLine: from, toLine: to, text: join(lines, from, to) };
}

function join(lines: LineReader, from: number, to: number): string {
  const out: string[] = [];
  for (let index = from; index <= to; index += 1) out.push(lines.read(index));
  return out.join("\n");
}

/* ------------------------------------------------------------- commands */

/** Prefix of the command id for every alignment; Obsidian adds the `markdown-toolkit:` part. */
export const TEXT_ALIGN_COMMAND_PREFIX = "text-align-";

/**
 * The id an alignment is registered under, and the one the menu points at.
 *
 * Defined here rather than next to the command registration so the toolbar's
 * default list can build its menu without importing from `features/`: the data
 * model stays free of the editor side, exactly like the rest of `core/`.
 */
export function textAlignCommandId(kind: AlignKind): string {
  return `markdown-toolkit:${TEXT_ALIGN_COMMAND_PREFIX}${kind}`;
}
