/**
 * Background colour, which Markdown has no syntax for either.
 *
 * The tag is the one `core/color-span` writes, carrying this feature's
 * declaration: `<span style="background-color:…">`. The reference plugin uses
 * `<mark style="background:…">` instead, and there is a reason to follow it —
 * a highlighter is what `mark` means — but two reasons not to. `mark` carries
 * a theme background of its own, so a note that has to look the same in a light
 * and a dark theme would be fighting the app's own styling for the colour the
 * user picked; and a line that is highlighted *and* coloured would need a
 * `mark` inside a `span`, which is the nesting this plugin refuses to write.
 * One span with two declarations is what a second press can take apart again.
 *
 * Everything else — one tag per line, a blank line left alone, a repeat press
 * taking the colour off rather than nesting — is inherited from `color-span`,
 * where the rules and the reasons for them are written down once.
 *
 * The palette is the reference plugin's, kept in its order and in its own
 * spelling: two bands of ten, the first translucent and the second the opaque
 * highlighter set. The editable band of custom swatches that used to close the
 * table is gone, and with it the settings field that stored one. One quirk is
 * copied deliberately rather than tidied away — the first two swatches of the
 * second translucent row are the same colour, which is what the reference
 * plugin ships and what its users will expect to find in the same place.
 */
import { applyColorProp, normalizeColor, type ColorResult } from "./color-span";

/* ------------------------------------------------------------- the palette */

/** The style property this feature owns; the other one belongs to font colour. */
const BACKGROUND_PROP = "background-color";

/**
 * `Translucent Colors`: two rows of five, read in the reference plugin's order.
 *
 * Held flat rather than as rows because five to a row is what the panel draws
 * either way — the row structure is in the grid, not in this list.
 *
 * The alpha channel is kept as it is declared instead of being flattened to an
 * opaque colour: a translucent highlight that lets the theme show through is
 * the whole point of this half of the palette, and a hex code cannot say it.
 */
export const TRANSLUCENT_COLORS: readonly string[] = [
  "rgba(140,140,140,0.12)",
  "rgba(92,92,92,0.2)",
  "rgba(163,67,31,0.2)",
  "rgba(240,107,5,0.2)",
  "rgba(240,200,0,0.2)",
  "rgba(3,135,102,0.2)",
  "rgba(3,135,102,0.2)",
  "rgba(5,117,197,0.2)",
  "rgba(74,82,199,0.2)",
  "rgba(136,49,204,0.2)",
];

/** `Highlighter Colors`: two rows of five, opaque, one per pen in the box. */
export const HIGHLIGHTER_COLORS: readonly string[] = [
  "rgb(255,248,143)",
  "rgb(211,248,182)",
  "rgb(175,250,209)",
  "rgb(177,255,255)",
  "rgb(253,191,255)",
  "rgb(210,203,255)",
  "rgb(64,169,255)",
  "rgb(255,77,79)",
  "rgb(212,177,6)",
  "rgb(146,84,222)",
];

/* ---------------------------------------------------------------- applying */

/**
 * The selection with `color` as its background, line by line.
 *
 * The deciding — take it off when every content line already reads that way,
 * put it on otherwise — is the shared mechanism's. What this adds is the one
 * policy that is background colour's own: `normalizeColor` rather than
 * `normalizeHex`, so the palette's translucent and `rgb()` swatches survive the
 * round trip, and so a hand-typed hex code still lands in the same canonical
 * form a swatch would have produced.
 */
export function applyBackground(text: string, color: string): ColorResult {
  return applyColorProp(text, BACKGROUND_PROP, color, normalizeColor);
}

/* ------------------------------------------------------------- commands */

/** The toolbar entry's id, so the settings page can detect it. */
export const BACKGROUND_COLOR_TOOL_ID = "background-color";

/**
 * The command every press of that entry ends in, and the one the command
 * palette and a hotkey reach directly.
 *
 * Not run by the toolbar, for the same reason as font colour's: the swatch
 * panel is a grid no native `Menu` can hold, so the toolbar opens the panel
 * itself, anchored to the button.
 */
export const BACKGROUND_COLOR_COMMAND_ID = "markdown-toolkit:change-background-color";

/**
 * The glyph the toolbar draws: a tilted highlighter with the colour under its
 * tip. Registered by this plugin rather than looked up in Obsidian's set,
 * because Lucide has no such icon.
 */
export const BACKGROUND_COLOR_ICON = "mtk-background-color";
