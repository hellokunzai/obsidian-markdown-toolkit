/**
 * Font colour, which Markdown has no syntax for either.
 *
 * The tag is the same shape text alignment writes, and for the same reason:
 * `<span>` is not in CommonMark's list of block tags, so the line stays a
 * paragraph and its inline Markdown is still parsed — a coloured line holding
 * `**bold**` renders the bold rather than showing asterisks. A wrapping tag
 * would have to be `<font color=…>`, which is deprecated, or `<div>`, which
 * swallows the Markdown.
 *
 * Three conventions, inherited from the rest of the plugin:
 *
 * 1. The work is a plain `string -> string` function over the text to colour, so
 *    every rule below can be exercised without an editor.
 * 2. Pressing the colour a selection already has takes it *off*, and pressing a
 *    different one *replaces* it rather than nesting a second span. The
 *    reference plugin nests, and does nothing at all on a repeat press; both
 *    leave the user without a way back to plain text except editing the source.
 * 3. One tag **per line**, not one around the block. A span opened on the first
 *    line of a selection and closed on the last would be split in two by any
 *    blank line in between, and a blank line is spacing rather than content —
 *    wrapping it would leave an empty pair of tags the user has to find and
 *    delete by hand.
 *
 * The tag itself — writing it, reading it back, and what happens when the line
 * already carries a background colour as well — lives in `core/color-span`,
 * shared with the background-colour feature. This file is the font-colour view
 * of that mechanism: its palette, and the one property it owns.
 *
 * The palette is Office's, copied from the reference plugin's own swatch table
 * so the two palettes read the same: ten hues in six shades, then ten standard
 * colours. The editable band of custom swatches that used to close the table is
 * gone, and with it the settings field that stored one.
 */
import { applyColorProp, normalizeHex, type ColorResult } from "./color-span";

// The result of an edit is the same shape for both colouring features, and so
// is its declaration: it lives beside the mechanism that produces it.
export type { ColorResult };

/* ------------------------------------------------------------- the palette */

/**
 * `Theme Colors`: ten hues, each in six shades.
 *
 * Held as rows rather than as a flat list of sixty because the rows *are* the
 * shades — the panel draws one row per shade and the reference table declares
 * them the same way. Flattening would lose the only structure in the data.
 */
export const THEME_ROWS: readonly (readonly string[])[] = [
  ["#ffffff", "#000000", "#eeece1", "#1f497d", "#4f81bd", "#c0504d", "#9bbb59", "#8064a2", "#4bacc6", "#f79646"],
  ["#f2f2f2", "#7f7f7f", "#ddd9c3", "#c6d9f0", "#dbe5f1", "#f2dcdb", "#ebf1dd", "#e5e0ec", "#dbeef3", "#fdeada"],
  ["#d8d8d8", "#595959", "#c4bd97", "#8db3e2", "#b8cce4", "#e5b9b7", "#d7e3bc", "#ccc1d9", "#b7dde8", "#fbd5b5"],
  ["#bfbfbf", "#3f3f3f", "#938953", "#548dd4", "#95b3d7", "#d99694", "#c3d69b", "#b2a2c7", "#92cddc", "#fac08f"],
  ["#a5a5a5", "#262626", "#494429", "#17365d", "#366092", "#953734", "#76923c", "#5f497a", "#31859b", "#e36c09"],
  ["#7f7f7f", "#0c0c0c", "#1d1b10", "#0f243e", "#244061", "#632423", "#4f6128", "#3f3151", "#205867", "#974806"],
];

/** `Standard Colors`: the ten saturated ones. */
export const STANDARD_COLORS: readonly string[] = [
  "#c00000",
  "#ff0000",
  "#ffc000",
  "#ffff00",
  "#92d050",
  "#00b050",
  "#00b0f0",
  "#0070c0",
  "#002060",
  "#7030a0",
];

/* ---------------------------------------------------------------- applying */

/**
 * The selection with `color` applied, line by line.
 *
 * The deciding — take it off when every content line already reads that way,
 * put it on otherwise — is the shared mechanism's, in `core/color-span`; what
 * this adds is the one policy that is font colour's own: the palette is hex
 * codes, so a press carrying anything else cannot mean anything and says so by
 * changing nothing.
 */
export function applyColor(text: string, color: string): ColorResult {
  return applyColorProp(text, "color", color, normalizeHex);
}

/* ------------------------------------------------------------- commands */

/** The toolbar entry's id, so the settings page can detect it. */
export const FONT_COLOR_TOOL_ID = "font-color";

/**
 * The command every press of that entry ends in, and the one the command
 * palette and a hotkey reach directly.
 *
 * The toolbar does not *run* it: the palette is a ten-column grid, which no
 * native `Menu` can hold, so the toolbar hands the press to the panel in
 * `ui/color-picker` instead. The command stays because the palette and hotkeys
 * need something to point at, and it opens the same panel anchored to the
 * caret.
 */
export const FONT_COLOR_COMMAND_ID = "markdown-toolkit:change-font-color";

/**
 * The glyph the toolbar draws.
 *
 * Registered by this plugin rather than looked up in Obsidian's set, because
 * an "A with a rule under it" is not a Lucide icon. The name is declared here
 * and the drawing lives beside the panel that needs it; a test asserts the two
 * halves still agree.
 */
export const FONT_COLOR_ICON = "mtk-font-color";
