/**
 * The editor-facing half of font colour.
 *
 * `core/font-color.ts` owns the palette and the policy; `features/color-apply`
 * owns the editor dance both colouring features share. What is left here is the
 * two-line description of *this* feature: which bands the panel shows, and
 * which core call a picked colour goes through.
 */
import type { Editor } from "obsidian";
import { STANDARD_COLORS, THEME_ROWS, applyColor } from "../core/font-color";
import { normalizeHex } from "../core/color-span";
import { t } from "../i18n";
import { applyToSelection, openColorPanel, type ColorNotices, type ColorPanelRequest } from "./color-apply";

const NOTICES: ColorNotices = {
  noEditor: "notice.colorNoEditor",
  noSelection: "notice.colorNoSelection",
  blank: "notice.colorNothing",
};

/**
 * Puts `color` on the selection — or takes it off, when the selection is
 * already in that colour. The core decides which; this only applies it.
 */
export function applyFontColor(editor: Editor, color: string): void {
  applyToSelection(editor, (text) => applyColor(text, color), NOTICES);
}

/**
 * The panel's two bands, in the order the reference plugin lists them.
 *
 * Both are fixed tables. The editable band of custom swatches that used to sit
 * under them is gone, along with the settings field that fed it — the two rows
 * above are the whole palette now.
 *
 * Exported because the browser harness builds its pages from it. A harness that
 * assembled its own bands would be measuring a panel nobody ships, and a
 * palette reordered here would go unnoticed there.
 */
export function fontColorBands(): ColorPanelRequest["bands"] {
  return [
    { caption: t("fontColor.colors.theme"), colors: THEME_ROWS.flat() },
    { caption: t("fontColor.colors.standard"), colors: STANDARD_COLORS },
  ];
}

/** Opens the swatch panel, anchored to the button that asked for it. */
export function openFontColorPicker(editor: Editor | null, anchor: HTMLElement | null): void {
  openColorPanel({
    editor,
    anchor,
    titleKey: "command.fontColor",
    bands: fontColorBands(),
    // Squares, ten to a row: the font palette is Office's colour table.
    round: false,
    // Hex only — the same policy `applyColor` applies with, so a colour the
    // panel accepts is a colour that feature can write.
    accepts: normalizeHex,
    apply: applyFontColor,
    notices: NOTICES,
  });
}
