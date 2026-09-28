import { Menu, Notice, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { chartSpec, isChartMode } from "../charts/registry";
import { chartSvgDocument } from "../charts/paint";
import { applyPinnedPositions, parseDiagram } from "../core/parse";
import { layoutFlow } from "../core/layout-flow";
import { layoutMindmap } from "../core/layout-mindmap";
import { modelBounds } from "../core/measure";
import { buildSvgDocument } from "../render/export";
import { writeDrawingFile, type DrawingFile, type ExportKind } from "../utils/export-file";
import { readPalette } from "../render/svg";
import type { DiagramMode } from "../core/model";
import type { MarkdownEditorPlusSettings } from "../settings";

/**
 * Getting a drawing out of the note and onto the disk.
 *
 * The block in the note and the full-screen preview are both read-only views of
 * the *source text*, not of a model someone has been editing: what they show is
 * whatever `parse()` makes of the fence. So "export" here is a fresh parse of
 * that same text — the file cannot disagree with the picture on screen, and
 * neither view needs to hold on to a model to be able to offer the entry.
 *
 * The two are the same operation for a second reason: the colours. A drawing
 * reads its palette off the element it was painted into (`--mtk-*` is stated per
 * surface), so exporting has to be told which element is on screen. The block
 * hands over its own box, the preview hands over its frame, and everything else
 * below is shared.
 */

/** The two formats the entry offers. Re-exported so the embed side imports one module. */
export type { ExportKind };

export interface BlockExportRequest {
  /** The note the drawing was read from; the file lands in its folder. */
  file: TFile | null;
  source: string;
  mode: DiagramMode;
  kind: ExportKind;
  /**
   * The element the drawing's colours are read from — a `.mtk-embed` box or the
   * preview's frame. An element outside either of those reads the theme's grey
   * fallbacks, and the exported file would not match what is on screen.
   */
  paletteFrom: Element;
}

/**
 * The formats, as a menu under the button that asked for them.
 *
 * One button rather than two, because the corner is a row of 26px squares: a
 * second and third square for "SVG" and "PNG" would push the entries that do
 * something to the block itself off the corner, and two glyphs that both mean
 * "download" are not two things a reader can tell apart anyway.
 *
 * The menu itself is Obsidian's own. Drawing one would mean rebuilding the
 * theme, the flip-up placement near the bottom of the window, closing on a
 * click outside, Escape, and keyboard navigation — the toolbar's submenus
 * already go through `Menu` for exactly that reason.
 */
export function openExportMenu(anchor: HTMLElement, onPick: (kind: ExportKind) => void): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(t("embed.exportSvg"))
      .setIcon("file-code")
      .onClick(() => onPick("svg"))
  );
  menu.addItem((item) =>
    item
      .setTitle(t("embed.exportPng"))
      .setIcon("image")
      .onClick(() => onPick("png"))
  );
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
}

/**
 * Renders the drawing standalone and writes it beside the note.
 *
 * The standalone-document builders are the ones the editors already export
 * through: the output carries no dependency on `styles.css`, so the file opens
 * correctly in a browser, an image viewer or a design tool. Choosing where it
 * lands and telling the user is `writeDrawingFile`'s job, shared with the
 * editor's own export — this function only turns source text into that document.
 */
export async function exportBlockDiagram(
  app: App,
  settings: MarkdownEditorPlusSettings,
  request: BlockExportRequest
): Promise<void> {
  const drawing = buildDocument(settings, request);
  if (!drawing) {
    new Notice(t("notice.emptyDiagram"));
    return;
  }
  await writeDrawingFile(app, request.file, request.kind, drawing);
}

/** `null` when there is nothing to draw — an empty or unreadable body. */
function buildDocument(
  settings: MarkdownEditorPlusSettings,
  request: BlockExportRequest
): DrawingFile | null {
  const palette = readPalette(request.paletteFrom);
  const background = request.kind === "png";

  // A chart lays itself out in its own coordinate space and hands back its own
  // bounds, so it comes with a size; a node graph is measured with `modelBounds`
  // because neither layout is centred on (0, 0) — a mindmap's root sits at x = 0
  // with unequal left/right spans, and a flow graph starts at the top-left. Two
  // builders, one shape — same split the editor panels use.
  if (isChartMode(request.mode)) {
    const spec = chartSpec(request.mode);
    const state = spec.parse(request.source);
    spec.layout(state);
    const chart = chartSvgDocument(spec, state, palette, { background });
    return chart ? { svg: chart.svg, width: chart.width, height: chart.height } : null;
  }

  const parsed = parseDiagram(request.source, request.mode);
  if (!parsed.ok) return null;

  const model = parsed.model;
  if (model.mode === "mindmap") layoutMindmap(model, settings.mindmapLayout);
  else layoutFlow(model);
  applyPinnedPositions(model);
  if (!model.nodes.length) return null;

  const bounds = modelBounds(model);
  if (!bounds) return null;

  // 48 is `buildSvgDocument`'s 24px padding on both sides, stated once here
  // because only the pixel size needs it — the viewBox is the builder's own.
  return {
    svg: buildSvgDocument(model, palette, { background }),
    width: Math.round(bounds.x2 - bounds.x1 + 48),
    height: Math.round(bounds.y2 - bounds.y1 + 48),
  };
}
