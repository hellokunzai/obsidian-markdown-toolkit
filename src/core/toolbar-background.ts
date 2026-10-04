/**
 * The editor toolbar's own background colour.
 *
 * The bar is drawn by `features/editor-toolbar.ts` across the top of the active
 * Markdown editor, and until now its colour was the theme's to decide
 * (`--background-secondary`, the same surface Obsidian gives a side bar). A
 * user who wants the bar to stand apart from the note — or to disappear into it
 * — has no lever for that through the theme, because a theme is the whole app
 * and this is one strip of it.
 *
 * The lever is a single custom property. `styles.css` paints the bar with
 * `var(--mtk-editor-toolbar-bg, var(--background-secondary))`, so the default
 * is exactly the colour it always was, and this module is everything around
 * that one line: which strings are allowed into it and where the inline
 * property is written and taken back out.
 *
 * Three decisions worth writing down:
 *
 * 1. **Empty means "no override", not "black".** `""` removes the property and
 *    the theme's colour comes back through the `var()` fallback. That is why
 *    the setting is a `string` whose default is `""` rather than an optional
 *    colour: "follow the theme" is a real answer the user can return to, and it
 *    has to survive a round trip through `data.json` like any other.
 * 2. **`var()` is accepted, not merely tolerated.** Naming a theme variable is
 *    how one colour survives both of Obsidian's themes — `var(--text-accent)`
 *    tracks whatever the user's theme does in light *and* dark, which no hex
 *    code can.
 * 3. **The value is validated, never "sanitised".** A `data.json` is text a
 *    user can edit by hand and this string ends up in a `style` property, so
 *    anything outside the accepted shapes is refused at the door (and the field
 *    says so) rather than written and left for the browser to interpret.
 */

/**
 * The property the bar reads; `styles.css` consumes it with a theme fallback.
 *
 * Named `--mtk-…` like the rest of this plugin's custom properties, so it can
 * be set from CSS as well as from the settings page — a theme or a snippet that
 * wants a different bar colour has somewhere to say so.
 */
export const TOOLBAR_BACKGROUND_VAR = "--mtk-editor-toolbar-bg";

/**
 * The value that means "do not override": the theme paints the bar.
 *
 * A real value rather than `null`, because it is what `DEFAULT_SETTINGS` holds
 * and what the field is cleared to; `null` is reserved for the one meaning it
 * needs — "not a colour at all".
 */
export const TOOLBAR_BACKGROUND_DEFAULT = "";

/** A bar with nothing behind it: the note shows through the strip. */
export const TOOLBAR_BACKGROUND_TRANSPARENT = "transparent";

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[^()]*\)$/;
const VAR = /^var\(\s*--[A-Za-z0-9_-]+(?:\s*,\s*[^()]*)?\)$/;
const BARE_VAR = /^--[A-Za-z0-9_-]+$/;

/**
 * A colour code, or `null` when the text is not one.
 *
 * `""` comes back as the default rather than as a refusal: clearing the box is
 * how a user goes back to the theme, and a field whose empty state is an error
 * gives them no way to say that.
 *
 * The one place case matters is the custom property *name*, so a `var()` is
 * kept exactly as written — `var(--MyAccent)` and `var(--myaccent)` are two
 * different variables, and lower-casing one would silently point at the other.
 * Colour codes have no case to keep, so they are folded to lower case, which
 * also makes two spellings of one colour compare equal to the preset swatches.
 */
export function normalizeToolbarBackground(raw: string): string | null {
  const text = raw.trim();
  if (text === TOOLBAR_BACKGROUND_DEFAULT) return TOOLBAR_BACKGROUND_DEFAULT;
  if (text.toLowerCase() === TOOLBAR_BACKGROUND_TRANSPARENT) return TOOLBAR_BACKGROUND_TRANSPARENT;
  // A bare `--name` is what people copy out of a theme; the wrapper is ours.
  if (BARE_VAR.test(text)) return `var(${text})`;
  if (VAR.test(text)) return text;
  if (HEX.test(text) || FUNC.test(text)) return text.toLowerCase();
  return null;
}

/**
 * Writes the colour onto the bar, or takes the property back out.
 *
 * `removeProperty` rather than writing the theme's colour in: the fallback
 * belongs in the stylesheet, one line away from the rule that consumes it, and
 * a bar with a colour written into its `style` attribute would keep painting
 * that colour after the setting had been cleared.
 *
 * A property rather than `backgroundColor`, because the same call then serves
 * the preview swatches: what is drawn on a swatch is literally the value the
 * bar would be painted with, not a second rendering of it that could drift.
 */
export function applyToolbarBackground(el: HTMLElement, value: string): void {
  if (value === TOOLBAR_BACKGROUND_DEFAULT) el.style.removeProperty(TOOLBAR_BACKGROUND_VAR);
  else el.style.setProperty(TOOLBAR_BACKGROUND_VAR, value);
}
