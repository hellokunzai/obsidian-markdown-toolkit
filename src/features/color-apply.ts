/**
 * The part both colouring features do the same way.
 *
 * Read the selection, open the panel anchored to the button that asked for it,
 * put the selection back, and write the one replacement — four steps that are
 * identical for font colour and background colour and would otherwise be
 * written out twice, drifting apart one Notice at a time.
 *
 * Two rules are inherited from underline and text alignment:
 *
 * - Only the selection is replaced. `setValue` would reset the selection and
 *   fold the edit into one undo step, and a colour applied by mistake has to
 *   come back with a single Ctrl+Z.
 * - The whole block stays selected afterwards. Colouring is applied to a
 *   selection and taken off by pressing the same colour again, so the second
 *   press has to see the tags the first one wrote.
 *
 * Nothing happens without a selection. Colour is an inline format — there is no
 * "the colour of this paragraph" for a caret to sit in — so the honest answer
 * to a press with nothing selected is to say so, rather than to colour a guess
 * at what was meant or to leave an empty pair of tags behind.
 */
import type { Editor, EditorPosition } from "obsidian";
import { Notice } from "obsidian";
import type { ColorResult } from "../core/color-span";
import { t } from "../i18n";
import { ColorPickerPanel, type ColorBand } from "../ui/color-picker";

/**
 * The three things a colouring feature has to be able to say.
 *
 * Keys rather than sentences: which language is active is decided when the
 * message is shown, not when the feature is built.
 */
export interface ColorNotices {
  /** Pressed with no editor open at all. */
  readonly noEditor: string;
  /** Pressed with nothing selected. */
  readonly noSelection: string;
  /** The selection held nothing but blank lines. */
  readonly blank: string;
}

/**
 * Where `text` ends, given that it starts at `from`.
 *
 * Deliberately the same four lines as the alignment feature's own copy: the
 * two are separate call sites with no shared owner, and a shared module for
 * one arithmetic step would be a dependency neither of them needs.
 */
function endWithin(from: EditorPosition, text: string): EditorPosition {
  const lines = text.split("\n");
  if (lines.length === 1) return { line: from.line, ch: from.ch + text.length };
  return { line: from.line + lines.length - 1, ch: lines[lines.length - 1].length };
}

/**
 * Writes the one edit a colouring feature makes.
 *
 * `transform` is the feature's core call, closed over the colour that was
 * picked; everything around it — the guards, the single `replaceRange`, the
 * selection that survives it — is the same for both.
 */
export function applyToSelection(
  editor: Editor,
  transform: (text: string) => ColorResult,
  notices: ColorNotices
): void {
  if (!editor.somethingSelected()) {
    new Notice(t(notices.noSelection));
    // The notice explains the press; it does not say where the next keystroke
    // should land, so the focus still goes back.
    editor.focus();
    return;
  }

  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const result = transform(editor.getSelection());
  if (!result.changed) {
    // A selection of nothing but blank lines — see `rewriteLines`. Saying so
    // beats reporting success for an edit that did not happen.
    new Notice(t(notices.blank));
    editor.focus();
    return;
  }

  editor.replaceRange(result.text, from, to);
  editor.setSelection(from, endWithin(from, result.text));
  editor.focus();
}

export interface ColorPanelRequest {
  readonly editor: Editor | null;
  readonly anchor: HTMLElement | null;
  /** What the panel is called — the command's own name. */
  readonly titleKey: string;
  readonly bands: readonly ColorBand[];
  readonly round: boolean;
  /** Which spellings a typed colour may use; see `ColorPickerOptions`. */
  readonly accepts: (value: string) => string | null;
  /** The custom swatches, of which the first seeds the hex field. */
  readonly custom: readonly string[];
  /** What a picked colour means. */
  readonly apply: (editor: Editor, color: string) => void;
  readonly notices: ColorNotices;
}

/**
 * Opens the swatch panel.
 *
 * The selection is read here, before the panel takes the focus, and put back
 * when a colour is chosen: the panel is a separate tree on `document.body` and
 * a press on one of its buttons is a press outside the editor, so nothing about
 * the editor's own selection can be assumed by the time the callback runs.
 */
export function openColorPanel(request: ColorPanelRequest): void {
  const { editor } = request;
  if (!editor) {
    new Notice(t(request.notices.noEditor));
    return;
  }

  const saved = { from: editor.getCursor("from"), to: editor.getCursor("to") };
  new ColorPickerPanel({
    title: t(request.titleKey),
    bands: request.bands,
    round: request.round,
    anchor: request.anchor,
    accepts: request.accepts,
    seed: request.custom[0] ?? "#000000",
    onPick: (color) => {
      editor.setSelection(saved.from, saved.to);
      request.apply(editor, color);
    },
  }).open();
}
