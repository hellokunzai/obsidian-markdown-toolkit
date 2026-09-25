import { createSurface, type DiagramSurface, type Palette } from "../render/svg";
import { ensureMarkers, setAttrs } from "./draw";
import type { ChartHandle, RegisteredSpec } from "./types";

/**
 * Painting a chart into a surface.
 *
 * Three callers need exactly this — the chart canvas in the editor, the preview
 * embedded in the note, and the SVG/PNG export — and they differ only in
 * whether the result is interactive and what is selected. Keeping the sequence
 * (register markers, clear the layer, render, collect the grips) in one place is
 * what stops the exported picture from drifting away from the on-screen one.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ChartPaintOptions {
  palette: Palette;
  /** Currently selected grip id, or null. */
  selected?: string | null;
  /** False for the read-only preview and for export. */
  interactive?: boolean;
  /**
   * Filled with every grip the spec registers, keyed by id.
   *
   * A grip's hit area is a circle in model coordinates, but the element that
   * carries `data-mtk` is the shape itself — so this map is what tells the panel
   * how a drag on that shape should behave, without the panel knowing anything
   * about what the shape means.
   */
  grips?: Map<string, ChartHandle>;
}

export function paintChart(
  surface: DiagramSurface,
  spec: RegisteredSpec,
  state: unknown,
  options: ChartPaintOptions
): void {
  ensureMarkers(surface.svg, options.palette);
  surface.layer.replaceChildren();
  spec.render({
    layer: surface.layer,
    state,
    palette: options.palette,
    selected: options.selected ?? null,
    interactive: options.interactive ?? false,
    grip: (handle) => {
      options.grips?.set(handle.id, handle);
    },
  });
  if (options.grips?.size) applyCursors(surface.layer, options.grips);
}

/**
 * Copies each grip's cursor onto the elements it marked.
 *
 * Written as an attribute rather than `style.cursor`, and mapped to real cursor
 * values in the stylesheet, for the same reason the rest of this plugin passes
 * computed values around as custom properties: what a cursor *is* belongs in
 * CSS, and the spec only says which affordance it wants.
 *
 * The payoff is concrete: on a gantt chart the bar and its right edge are two
 * different gestures — "move this" versus "make it longer" — and without this
 * they would look identical under the pointer.
 */
function applyCursors(layer: SVGGElement, grips: Map<string, ChartHandle>): void {
  for (const handle of grips.values()) {
    if (!handle.cursor) continue;
    const marked = layer.querySelectorAll(`[data-mtk="${CSS.escape(handle.id)}"]`);
    for (const node of marked) node.setAttribute("data-mtk-cursor", handle.cursor);
  }
}

export interface ChartSvgDocument {
  svg: string;
  width: number;
  height: number;
}

export interface ChartExportOptions {
  padding?: number;
  /** Fill the canvas with the surface colour instead of leaving it transparent. */
  background?: boolean;
}

/**
 * Standalone SVG for a chart.
 *
 * Same contract as `buildSvgDocument`: no dependency on the plugin's
 * stylesheet, every colour carried as a presentation attribute, and a wrapper
 * that supplies the viewBox and the size. The one difference is the origin — a
 * graph model is centred on `(0, 0)`, while a chart lays itself out in its own
 * coordinate space, so the viewBox is taken straight from the spec's bounds
 * rather than assumed to be symmetric.
 */
export function chartSvgDocument(
  spec: RegisteredSpec,
  state: unknown,
  palette: Palette,
  options: ChartExportOptions = {}
): ChartSvgDocument | null {
  const bounds = spec.extent(state);
  if (!bounds) return null;

  const padding = options.padding ?? 26;
  const host = document.createElement("div");
  const surface = createSurface(host);
  paintChart(surface, spec, state, { palette, interactive: false });

  const width = Math.max(1, Math.round(bounds.x2 - bounds.x1 + padding * 2));
  const height = Math.max(1, Math.round(bounds.y2 - bounds.y1 + padding * 2));
  const x = Math.round(bounds.x1 - padding);
  const y = Math.round(bounds.y1 - padding);
  setAttrs(surface.svg, { viewBox: `${x} ${y} ${width} ${height}`, width, height });
  surface.svg.removeAttribute("class");

  if (options.background) {
    const rect = document.createElementNS(SVG_NS, "rect");
    setAttrs(rect, { x, y, width, height, fill: palette.surface });
    surface.svg.insertBefore(rect, surface.svg.firstChild);
  }

  const body = new XMLSerializer().serializeToString(surface.svg);
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, width, height };
}
