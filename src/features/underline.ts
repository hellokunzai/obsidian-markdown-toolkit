/**
 * Toggle underline.
 *
 * Obsidian's Markdown has no underline, so this writes the HTML tag that both
 * reading view and live preview render. The tag pair and the offset arithmetic
 * live in `core/format-toggle.ts`; this file is only the editor-facing half:
 * read the document and the selection, ask for the edit, apply it to the one
 * span that changed, and put the caret back where typing can continue.
 *
 * It is a command rather than a toolbar-only feature for the same reason the
 * format brush is: the toolbar executes command ids, and Obsidian has no
 * underline command to point at. That also makes it reachable from the command
 * palette and assignable to a hotkey.
 */
import type { Editor } from "obsidian";
import { toggleWrap } from "../core/format-toggle";

/** The tag pair, exported so the format brush can recognise underlined text. */
export const UNDERLINE_OPEN = "<u>";
export const UNDERLINE_CLOSE = "</u>";

/** The id the default toolbar points at — the plugin prefix is added by Obsidian. */
export const UNDERLINE_COMMAND_ID = "markdown-toolkit:toggle-underline";

export function toggleUnderline(editor: Editor): void {
  const span = toggleWrap(
    editor.getValue(),
    editor.posToOffset(editor.getCursor("from")),
    editor.posToOffset(editor.getCursor("to")),
    UNDERLINE_OPEN,
    UNDERLINE_CLOSE
  );

  // Only the changed span is replaced. `setValue` would also work and would be
  // shorter, but it resets the selection and folds the whole edit into one
  // undo step, and the point of a toggle is to be undone by pressing it again.
  editor.replaceRange(span.insert, editor.offsetToPos(span.from), editor.offsetToPos(span.to));
  editor.setSelection(editor.offsetToPos(span.selStart), editor.offsetToPos(span.selEnd));
  // A click on the toolbar button takes the focus with it; without this the
  // next keystroke goes nowhere until the user clicks back into the note.
  editor.focus();
}
