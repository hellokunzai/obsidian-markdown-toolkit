import type { DiagramModel } from "../core/model";
import { modelExtent, createSurface, renderDiagram, setAttrs, type Palette } from "./svg";

/**
 * Standalone SVG / PNG output.
 *
 * The exported document carries no dependency on the plugin's stylesheet: every
 * colour arrives as a presentation attribute, and the wrapper supplies a
 * viewBox, a size and (optionally) a background rectangle. That is what makes
 * the file open correctly in a browser, an image viewer or a design tool.
 */

export interface ExportOptions {
  padding?: number;
  /** Fill the canvas with the surface colour instead of leaving it transparent. */
  background?: boolean;
}

export function buildSvgDocument(model: DiagramModel, palette: Palette, options: ExportOptions = {}): string {
  const padding = options.padding ?? 24;
  const host = document.createElement("div");
  const surface = createSurface(host);
  renderDiagram(surface, model, { interactive: false, selectedId: null }, palette);

  const extent = modelExtent(model);
  const width = Math.max(1, Math.round(extent.w + padding * 2));
  const height = Math.max(1, Math.round(extent.h + padding * 2));

  const viewBox = `${Math.round(-extent.w / 2 - padding)} ${Math.round(-extent.h / 2 - padding)} ${width} ${height}`;
  setAttrs(surface.svg, { viewBox, width, height });
  surface.svg.removeAttribute("class");

  if (options.background) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    setAttrs(rect, {
      x: Math.round(-extent.w / 2 - padding),
      y: Math.round(-extent.h / 2 - padding),
      width,
      height,
      fill: palette.surface,
    });
    surface.svg.insertBefore(rect, surface.svg.firstChild);
  }

  const body = new XMLSerializer().serializeToString(surface.svg);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/** Rasterises an SVG document through a canvas; returns PNG bytes. */
export async function rasterizeSvg(
  svgText: string,
  width: number,
  height: number,
  scale = 2
): Promise<ArrayBuffer> {
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("svg image decode failed"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d context unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("png encoding failed");
    return await png.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}
