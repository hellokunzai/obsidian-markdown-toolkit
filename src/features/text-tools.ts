/**
 * The editor-facing half of the text tools.
 *
 * `core/text-tools.ts` owns every transformation; this file only answers three
 * questions: what text the tool should look at, how the answer gets written
 * back, and which of the fifteen need a dialog first.
 *
 * Two rules are inherited from the underline command and hold for all fifteen:
 *
 * - Only the changed span is replaced. `setValue` would reset the selection and
 *   fold the whole edit into one undo step, and a tool the user wants to undo
 *   with a single Ctrl+Z must not swallow the history around it.
 * - A tool that changes nothing does not touch the document at all. Writing an
 *   identical string back would still push an undo entry and look like the
 *   command had done something.
 */
import type { App, Editor, EditorPosition } from "obsidian";
import { Notice } from "obsidian";
import { t } from "../i18n";
import { TextToolModal } from "../ui/text-tool-modal";
import {
  addAffix,
  addLineNumbers,
  collapseSpaces,
  extractBetween,
  hasNumberPlaceholder,
  insertBlankLines,
  listToTable,
  mergeLines,
  removeAllWhitespace,
  removeBlankLines,
  removeDuplicateLines,
  splitLines,
  stripMarkdown,
  tableToList,
  toHalfWidth,
  trimLines,
  type TextToolSlug,
} from "../core/text-tools";

// The id builder lives with the catalog, so the toolbar's default list can use
// it without reaching into `features/`. Re-exported here for the call sites
// that already think in terms of "the commands this feature registers".
export { textToolCommandId, TEXT_TOOL_COMMAND_PREFIX } from "../core/text-tools";

/** The span a tool works on: an explicit selection, or the whole document. */
interface ToolTarget {
  editor: Editor;
  from: EditorPosition;
  to: EditorPosition;
  text: string;
  /** True when nothing was selected and the whole note is the target. */
  whole: boolean;
}

/**
 * The selection, or the whole note when there is none.
 *
 * `from`/`to` are captured here rather than read at apply time, because a
 * dialog takes the focus and the selection with it: by the time the user has
 * typed a prefix and pressed Enter, the editor no longer remembers what was
 * selected when they opened the menu.
 */
function capture(editor: Editor): ToolTarget {
  if (editor.somethingSelected()) {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    return { editor, from, to, text: editor.getRange(from, to), whole: false };
  }
  const last = editor.lastLine();
  return {
    editor,
    from: { line: 0, ch: 0 },
    to: { line: last, ch: editor.getLine(last).length },
    text: editor.getValue(),
    whole: true,
  };
}

/** Where `text` ends, given that it starts at `from`. */
function endWithin(from: EditorPosition, text: string): EditorPosition {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: from.line, ch: from.ch + text.length };
  return { line: from.line + lines.length - 1, ch: lines[lines.length - 1].length };
}

/**
 * Writes a tool's result back, or says why nothing happened.
 *
 * A selection stays selected over the result, so the tools chain: dedupe then
 * trim then collapse, each seeing what the last one produced. A whole-document
 * edit leaves the caret at the top instead — selecting the entire note would
 * leave the editor in a state where the next keystroke wipes it.
 */
export function applyTextTool(target: ToolTarget, next: string, emptyKey = "notice.textToolUnchanged"): void {
  if (next === target.text) {
    new Notice(t(emptyKey));
    return;
  }
  target.editor.replaceRange(next, target.from, target.to);
  if (target.whole) target.editor.setCursor(target.from);
  else target.editor.setSelection(target.from, endWithin(target.from, next));
  // Pressing a toolbar button or a menu item moves the focus with it; without
  // this the next keystroke goes nowhere until the user clicks back in.
  target.editor.focus();
}

/** Runs once the dialog has finished closing, so the editor really gets the focus. */
function afterDialog(run: () => void): void {
  window.setTimeout(run, 0);
}

/* --------------------------------------------------------------- dialogs */

function openAffix(target: ToolTarget, app: App): void {
  new TextToolModal(
    app,
    t("textTool.modal.affix.heading"),
    t("textTool.modal.affix.note"),
    [
      { key: "prefix", label: t("textTool.modal.affix.prefix"), placeholder: t("textTool.modal.affix.prefixPlaceholder") },
      { key: "suffix", label: t("textTool.modal.affix.suffix"), placeholder: t("textTool.modal.affix.suffixPlaceholder") },
    ],
    t("textTool.modal.submit"),
    (values) => {
      if (values.prefix === "" && values.suffix === "") return t("textTool.modal.affix.needOne");
      afterDialog(() => applyTextTool(target, addAffix(target.text, values.prefix, values.suffix)));
      return null;
    }
  ).open();
}

function openLineNumbers(target: ToolTarget, app: App): void {
  new TextToolModal(
    app,
    t("textTool.modal.lineNumber.heading"),
    t("textTool.modal.lineNumber.note"),
    [
      { key: "start", label: t("textTool.modal.lineNumber.start"), value: "1" },
      {
        key: "format",
        label: t("textTool.modal.lineNumber.format"),
        value: "{n}. ",
        hint: t("textTool.modal.lineNumber.formatHint"),
      },
    ],
    t("textTool.modal.submit"),
    (values) => {
      if (!/^-?\d+$/.test(values.start)) return t("textTool.modal.lineNumber.badStart");
      if (!hasNumberPlaceholder(values.format)) return t("textTool.modal.lineNumber.needPlaceholder");
      const start = Number.parseInt(values.start, 10);
      afterDialog(() => applyTextTool(target, addLineNumbers(target.text, start, values.format)));
      return null;
    }
  ).open();
}

function openExtract(target: ToolTarget, app: App): void {
  new TextToolModal(
    app,
    t("textTool.modal.extract.heading"),
    t("textTool.modal.extract.note"),
    [
      { key: "start", label: t("textTool.modal.extract.start"), value: "(" },
      { key: "end", label: t("textTool.modal.extract.end"), value: ")" },
    ],
    t("textTool.modal.submit"),
    (values) => {
      if (values.start === "" || values.end === "") return t("textTool.modal.extract.needBoth");
      afterDialog(() =>
        applyTextTool(target, extractBetween(target.text, values.start, values.end), "notice.textToolNoMatch")
      );
      return null;
    }
  ).open();
}

/* ------------------------------------------------------------- executors */

/**
 * What each tool does, keyed by slug.
 *
 * Typed as a full `Record<TextToolSlug, …>` on purpose: adding a tool to the
 * catalog without saying how it runs, or renaming one, then fails the build
 * instead of producing a menu item that does nothing.
 */
const EXECUTORS: Record<TextToolSlug, (target: ToolTarget, app: App) => void> = {
  plain: (target) => applyTextTool(target, stripMarkdown(target.text)),
  "half-width": (target) => applyTextTool(target, toHalfWidth(target.text)),
  "blank-insert": (target) => applyTextTool(target, insertBlankLines(target.text)),
  "blank-remove": (target) => applyTextTool(target, removeBlankLines(target.text)),
  split: (target) => applyTextTool(target, splitLines(target.text)),
  merge: (target) => applyTextTool(target, mergeLines(target.text)),
  dedupe: (target) => applyTextTool(target, removeDuplicateLines(target.text)),
  affix: (target, app) => openAffix(target, app),
  "line-number": (target, app) => openLineNumbers(target, app),
  trim: (target) => applyTextTool(target, trimLines(target.text)),
  collapse: (target) => applyTextTool(target, collapseSpaces(target.text)),
  "strip-space": (target) => applyTextTool(target, removeAllWhitespace(target.text)),
  "list-table": (target) =>
    applyTextTool(target, listToTable(target.text, t("textTool.table.levelHeader"))),
  "table-list": (target) => applyTextTool(target, tableToList(target.text)),
  extract: (target, app) => openExtract(target, app),
};

/** Runs one tool against the active editor. */
export function runTextTool(app: App, editor: Editor, slug: TextToolSlug): void {
  EXECUTORS[slug](capture(editor), app);
}
