/**
 * The editor-facing half of text alignment.
 *
 * `core/text-align.ts` owns the wrapper and works out which lines a press
 * covers; this file only reads the document, writes the single replacement and
 * puts the caret back where typing can continue.
 *
 * Two rules are inherited from underline and the text tools:
 *
 * - Only the lines in play are replaced. `setValue` would reset the selection
 *   and fold the edit into one undo step, and a paragraph centred by mistake
 *   has to come back with a single Ctrl+Z.
 * - The block is replaced whole, tags and all. Aligning is a property of the
 *   paragraph rather than of a span inside it, so a second press has to see the
 *   wrapper the first one wrote in order to switch or remove it.
 */
import type { Editor, EditorPosition } from "obsidian";
import { Notice } from "obsidian";
import { t } from "../i18n";
import {
  alignTarget,
  applyAlignment,
  type AlignKind,
  type AlignRequest,
  type LineReader,
} from "../core/text-align";

// The id builder lives with the catalog, so the toolbar's default list can use
// it without reaching into `features/`. Re-exported here for the call sites
// that already think in terms of "the commands this feature registers".
export { textAlignCommandId, TEXT_ALIGN_COMMAND_PREFIX } from "../core/text-align";

/** The document as the core module sees it: just enough to read lines off. */
function reader(editor: Editor): LineReader {
  return { count: editor.lastLine() + 1, read: (index) => editor.getLine(index) };
}

/** The caret and the selection, read once before anything moves. */
function captureAlign(editor: Editor): AlignRequest {
  const caret = editor.getCursor();
  if (!editor.somethingSelected()) return { selection: null, caret };
  return {
    selection: { from: editor.getCursor("from"), to: editor.getCursor("to") },
    caret,
  };
}

/** Where `text` ends, given that it starts at `from`. */
function endWithin(from: EditorPosition, text: string): EditorPosition {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: from.line, ch: from.ch + text.length };
  return { line: from.line + lines.length - 1, ch: lines[lines.length - 1].length };
}

/** Keeps a computed offset inside the text it indexes into. */
function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Aligns the paragraph at the caret, or the selected lines, one way.
 *
 * The same function is behind all four buttons: which one was pressed is the
 * only difference, and the core decides the rest — a press on the alignment a
 * block already has takes it off, a press on another one swaps the tag.
 */
export function applyTextAlign(editor: Editor, kind: AlignKind): void {
  const request = captureAlign(editor);
  const target = alignTarget(reader(editor), request);
  if (!target) {
    // A caret on a blank line belongs to no paragraph, so the press has nothing
    // it could have meant. Saying so beats writing an empty span the user
    // cannot see and would have to delete in the source.
    new Notice(t("notice.textAlignNoParagraph"));
    // The focus still goes back: the notice explains the press, it does not say
    // where the next keystroke should land.
    editor.focus();
    return;
  }

  const from: EditorPosition = { line: target.fromLine, ch: 0 };
  const to: EditorPosition = { line: target.toLine, ch: editor.getLine(target.toLine).length };
  const start = editor.posToOffset(from);
  const result = applyAlignment(target.text, kind);

  if (request.selection) {
    editor.replaceRange(result.text, from, to);
    // The whole block stays selected rather than just the text inside the tags:
    // the next press is very likely another alignment, and switching one has to
    // see the wrapper the last one wrote.
    editor.setSelection(from, endWithin(from, result.text));
  } else {
    // The caret keeps its place inside the paragraph. `delta` moves it across
    // the tag that grew or shrank in front of it — including the newline that
    // pushes a multi-line paragraph down one line.
    const caret = clamp(editor.posToOffset(request.caret) - start + result.delta, 0, result.text.length);
    editor.replaceRange(result.text, from, to);
    editor.setCursor(editor.offsetToPos(start + caret));
  }
  // A click on a toolbar button takes the focus with it; without this the next
  // keystroke goes nowhere until the user clicks back into the note.
  editor.focus();
}
