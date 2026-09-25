/**
 * The editor-facing half of background colour.
 *
 * The same two-line description as `features/font-color.ts`: the bands this
 * panel shows, and the core call a picked colour goes through. Everything else
 * — the selection, the one replacement, the notices — is `features/color-apply`.
 */
import type { Editor } from "obsidian";
import { HIGHLIGHTER_COLORS, TRANSLUCENT_COLORS, applyBackground } from "../core/background-color";
import { normalizeColor } from "../core/color-span";
import { t } from "../i18n";
import { applyToSelection, openColorPanel, type ColorNotices, type ColorPanelRequest } from "./color-apply";

const NOTICES: ColorNotices = {
  noEditor: "notice.colorNoEditor",
  noSelection: "notice.colorNoSelection",
  blank: "notice.colorNothing",
};

/**
 * Puts `color` behind the selection — or takes it off, when the selection
 * already reads that way.
 */
export function applyBackgroundColor(editor: Editor, color: string): void {
  applyToSelection(editor, (text) => applyBackground(text, color), NOTICES);
}

/**
 * The panel's two bands, in the order the reference plugin lists them.
 *
 * Two bands of ten rather than one of twenty, because that is where the panel
 * breaks them: the first is the translucent set, which lets the theme show
 * through, and the second is the opaque highlighters. The editable band of
 * custom swatches that used to sit under them is gone, along with the settings
 * field that fed it.
 *
 * Exported for the same reason as its font-colour twin: the browser harness
 * builds the panel it measures from this, not from a second copy.
 */
export function backgroundColorBands(): ColorPanelRequest["bands"] {
  return [
    { caption: t("backgroundColor.colors.translucent"), colors: TRANSLUCENT_COLORS },
    { caption: t("backgroundColor.colors.highlighter"), colors: HIGHLIGHTER_COLORS },
  ];
}

/** Opens the swatch panel, anchored to the button that asked for it. */
export function openBackgroundColorPicker(editor: Editor | null, anchor: HTMLElement | null): void {
  openColorPanel({
    editor,
    anchor,
    titleKey: "command.backgroundColor",
    bands: backgroundColorBands(),
    // Circles, five to a row: the reference plugin draws its highlighters as
    // pen caps, and a cap is round.
    round: true,
    // Hex *or* rgb()/rgba() — half of this palette has an alpha channel, and a
    // translucent highlight of one's own cannot be typed any other way.
    accepts: normalizeColor,
    apply: applyBackgroundColor,
    notices: NOTICES,
  });
}
