import type { DiagramModel } from "../core/model";
import { modelBounds } from "../core/measure";
import { createSurface, renderDiagram, setAttrs, type Palette } from "./svg";

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

  const bounds = modelBounds(model);
  // An empty model has no bounds; emit a tiny transparent canvas rather than
  // throwing. Every real caller filters empty models out earlier, but staying
  // safe here keeps `buildSvgDocument` usable from tests and future callers.
  if (!bounds) {
    setAttrs(surface.svg, { viewBox: "0 0 1 1", width: 1, height: 1 });
    surface.svg.removeAttribute("class");
    const empty = new XMLSerializer().serializeToString(surface.svg);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${empty}`;
  }

  // The drawing is *not* centred on (0, 0): a mindmap's root sits at x = 0 with
  // unequal left/right spans, and a flow graph starts at the top-left. Deriving
  // the viewBox from the real bounding box (not a symmetric assumption) is what
  // stops the right side from being clipped.
  const ox = Math.round(bounds.x1 - padding);
  const oy = Math.round(bounds.y1 - padding);
  const width = Math.max(1, Math.round(bounds.x2 - bounds.x1 + padding * 2));
  const height = Math.max(1, Math.round(bounds.y2 - bounds.y1 + padding * 2));
  const viewBox = `${ox} ${oy} ${width} ${height}`;
  setAttrs(surface.svg, { viewBox, width, height });
  surface.svg.removeAttribute("class");

  if (options.background) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    setAttrs(rect, {
      x: ox,
      y: oy,
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
