import { textUnits, wrapLabel } from "../core/measure";
import { setAttrs, type Palette } from "../render/svg";

/**
 * Drawing primitives shared by every chart canvas.
 *
 * Same two rules as `render/svg.ts`, for the same two reasons: elements are
 * built with `createElementNS` (labels are arbitrary user text and must never
 * reach `innerHTML`), and every paint property is a presentation attribute (so
 * an exported `.svg` still looks right without the plugin's stylesheet).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Marker ids, registered once per surface in `ensureMarkers`. */
export const MARKERS = {
  arrow: "mtk-mk-arrow",
  triangle: "mtk-mk-tri",
  triangleFilled: "mtk-mk-tri-f",
  diamond: "mtk-mk-dia",
  diamondFilled: "mtk-mk-dia-f",
  cross: "mtk-mk-cross",
} as const;

export type MarkerName = keyof typeof MARKERS;

export function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export { setAttrs };

export function group(parent: Element, cls: string): SVGGElement {
  const node = el("g");
  if (cls) node.classList.add(cls);
  parent.appendChild(node);
  return node;
}

/** Attaches the stable id the panel uses to find a draggable element again. */
export function mark(node: Element, id: string | undefined): void {
  if (id) node.setAttribute("data-mtk", id);
}

export interface BoxOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  rx?: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  dash?: string;
  id?: string;
  cls?: string;
}

/** Top-left anchored rectangle. Most charts position boxes by corner, not centre. */
export function box(parent: Element, o: BoxOptions): SVGRectElement {
  const rect = el("rect");
  const stroke = o.stroke ?? "none";
  setAttrs(rect, {
    x: round(o.x),
    y: round(o.y),
    width: round(o.w),
    height: round(o.h),
    rx: o.rx ?? 6,
    fill: o.fill ?? "none",
    stroke,
    "stroke-width": o.sw ?? 1,
    "stroke-dasharray": o.dash,
    // Keeps hairlines hairlines when the viewport is zoomed out.
    "vector-effect": "non-scaling-stroke",
  });
  if (o.cls) rect.classList.add(o.cls);
  mark(rect, o.id);
  parent.appendChild(rect);
  return rect;
}

/** Centred rectangle — the shape an outline handles naturally. */
export function boxAt(parent: Element, cx: number, cy: number, w: number, h: number, o: Partial<BoxOptions> = {}): SVGRectElement {
  return box(parent, { ...o, x: cx - w / 2, y: cy - h / 2, w, h });
}

export interface EllipseOptions {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  id?: string;
}

export function ellipse(parent: Element, o: EllipseOptions): SVGEllipseElement {
  const node = el("ellipse");
  setAttrs(node, {
    cx: round(o.cx),
    cy: round(o.cy),
    rx: round(o.rx),
    ry: round(o.ry),
    fill: o.fill ?? "none",
    stroke: o.stroke ?? "none",
    "stroke-width": o.sw ?? 1,
    "vector-effect": "non-scaling-stroke",
  });
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

export interface LineOptions {
  stroke: string;
  sw?: number;
  dash?: string;
  markerEnd?: MarkerName;
  markerStart?: MarkerName;
  id?: string;
}

export function line(parent: Element, x1: number, y1: number, x2: number, y2: number, o: LineOptions): SVGLineElement {
  const node = el("line");
  setAttrs(node, {
    x1: round(x1),
    y1: round(y1),
    x2: round(x2),
    y2: round(y2),
    stroke: o.stroke,
    "stroke-width": o.sw ?? 1.2,
    "stroke-dasharray": o.dash,
    "stroke-linecap": "round",
    "vector-effect": "non-scaling-stroke",
  });
  applyMarkers(node, o);
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

export function path(parent: Element, d: string, o: LineOptions & { fill?: string }): SVGPathElement {
  const node = el("path");
  setAttrs(node, {
    d,
    fill: o.fill ?? "none",
    stroke: o.stroke,
    "stroke-width": o.sw ?? 1.2,
    "stroke-dasharray": o.dash,
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
    "vector-effect": "non-scaling-stroke",
  });
  applyMarkers(node, o);
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

export function polygon(parent: Element, points: string, o: Partial<BoxOptions>): SVGPolygonElement {
  const node = el("polygon");
  setAttrs(node, {
    points,
    fill: o.fill ?? "none",
    stroke: o.stroke ?? "none",
    "stroke-width": o.sw ?? 1,
    "vector-effect": "non-scaling-stroke",
  });
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

function applyMarkers(node: Element, o: LineOptions): void {
  if (o.markerEnd) node.setAttribute("marker-end", `url(#${MARKERS[o.markerEnd]})`);
  if (o.markerStart) node.setAttribute("marker-start", `url(#${MARKERS[o.markerStart]})`);
}

export interface TextOptions {
  size?: number;
  color?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  /** Clip width, so a stray glyph cannot poke out of its own box. */
  maxUnits?: number;
  maxLines?: number;
  halo?: string;
  /** Turns the text element into a grip target (labels are often what you grab). */
  id?: string;
  cls?: string;
}

/**
 * Multi-line text. `x` is the anchor point and `y` the vertical centre of the
 * block, which is how a label sits inside its own box.
 */
export function text(parent: Element, value: string, x: number, y: number, o: TextOptions = {}): SVGTextElement {
  const size = o.size ?? 13;
  const lines = wrapLabel(value, o.maxUnits, o.maxLines ?? 3);
  const step = Math.round(size * 1.42);
  const node = el("text");
  const cls = o.cls ?? "mtk-chart-label";
  node.classList.add(cls);
  setAttrs(node, {
    x: round(x),
    y: round(y),
    "text-anchor": o.anchor ?? "middle",
    "dominant-baseline": "central",
    "font-size": size,
    "font-weight": o.weight,
    fill: o.color,
    // A halo makes a label readable where it crosses a line.
    stroke: o.halo,
    "stroke-width": o.halo ? 3.4 : undefined,
    "paint-order": o.halo ? "stroke" : undefined,
  });
  const first = -((lines.length - 1) * step) / 2;
  lines.forEach((line, index) => {
    const tspan = el("tspan");
    setAttrs(tspan, { x: round(x), y: round(y + first + index * step) });
    tspan.textContent = line;
    node.appendChild(tspan);
  });
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

/** A single line of text, no wrapping. Used for badges and axis ticks. */
export function caption(parent: Element, value: string, x: number, y: number, o: TextOptions = {}): SVGTextElement {
  const node = el("text");
  node.classList.add(o.cls ?? "mtk-chart-caption");
  setAttrs(node, {
    x: round(x),
    y: round(y),
    "text-anchor": o.anchor ?? "start",
    "dominant-baseline": "central",
    "font-size": o.size ?? 11,
    fill: o.color,
    "font-weight": o.weight,
    stroke: o.halo,
    "stroke-width": o.halo ? 3 : undefined,
    "paint-order": o.halo ? "stroke" : undefined,
  });
  node.textContent = value;
  mark(node, o.id);
  parent.appendChild(node);
  return node;
}

/** Width of a label in model units, for laying out boxes before drawing them. */
export function textWidth(value: string, size = 13): number {
  return Math.round(textUnits(value) * size * 0.53);
}

export function measureText(value: string, size = 13, maxUnits = 44): ChartSizeValue {
  const lines = wrapLabel(value, maxUnits, 4);
  const widest = lines.reduce((max, l) => Math.max(max, textUnits(l)), 0);
  return { w: Math.max(60, Math.round(widest * size * 0.53) + 24), h: lines.length * Math.round(size * 1.42) + 16, lines };
}

interface ChartSizeValue {
  w: number;
  h: number;
  lines: string[];
}

/** Selection halo: drawn *under* the element so it never covers the label. */
export function halo(parent: Element, x: number, y: number, w: number, h: number, accent: string, rx = 8): void {
  const rect = el("rect");
  setAttrs(rect, {
    x: round(x - 4),
    y: round(y - 4),
    width: round(w + 8),
    height: round(h + 8),
    rx,
    fill: "none",
    stroke: accent,
    "stroke-width": 1.2,
    "stroke-dasharray": "4 3",
    "vector-effect": "non-scaling-stroke",
  });
  parent.appendChild(rect);
}

/**
 * The categorical palette.
 *
 * Fixed HSL hues rather than theme colours: a pie chart needs six *different*
 * colours and the theme supplies one accent. The lightness and saturation are
 * picked so the same set stays legible on both a light and a dark surface.
 */
export function seriesColor(palette: Palette, index: number): string {
  void palette;
  const hues = [258, 210, 160, 42, 8, 320, 190, 292];
  const hue = hues[index % hues.length];
  const cycle = Math.floor(index / hues.length);
  const light = cycle % 2 === 0 ? 52 : 40;
  return `hsl(${hue}, 58%, ${light}%)`;
}

/** A dimmer stroke derived from a series colour, for outlines. */
export function seriesStroke(index: number): string {
  const hues = [258, 210, 160, 42, 8, 320, 190, 292];
  const hue = hues[index % hues.length];
  return `hsl(${hue}, 52%, 34%)`;
}

/**
 * Registers the marker shapes the chart canvases need.
 *
 * `createSurface` already adds a single arrow for flowcharts; this adds the
 * rest (hollow triangle for inheritance, filled diamonds for composition and
 * aggregation, a cross for cardinality) and repaints all of them, because the
 * palette is re-read on every theme change.
 */
export function ensureMarkers(svg: SVGSVGElement, palette: Palette): void {
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = el("defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  const specs: Array<{ id: string; box: string; refX: number; body: string; fill: string; stroke: string }> = [
    { id: MARKERS.arrow, box: "0 0 10 10", refX: 9, body: "M0 0 L10 5 L0 10 z", fill: palette.edge, stroke: palette.edge },
    { id: MARKERS.triangle, box: "0 0 12 12", refX: 11, body: "M0 0 L12 6 L0 12 z", fill: palette.surface, stroke: palette.edge },
    { id: MARKERS.triangleFilled, box: "0 0 12 12", refX: 11, body: "M0 0 L12 6 L0 12 z", fill: palette.edge, stroke: palette.edge },
    { id: MARKERS.diamond, box: "0 0 14 10", refX: 13, body: "M0 5 L7 0 L14 5 L7 10 z", fill: palette.surface, stroke: palette.edge },
    { id: MARKERS.diamondFilled, box: "0 0 14 10", refX: 13, body: "M0 5 L7 0 L14 5 L7 10 z", fill: palette.edge, stroke: palette.edge },
    { id: MARKERS.cross, box: "0 0 8 8", refX: 7, body: "M0 0 L8 8 M8 0 L0 8", fill: "none", stroke: palette.edge },
  ];

  for (const spec of specs) {
    let marker = defs.querySelector(`#${spec.id}`);
    if (!marker) {
      marker = el("marker");
      setAttrs(marker, {
        id: spec.id,
        viewBox: spec.box,
        markerWidth: 7,
        markerHeight: 7,
        orient: "auto-start-reverse",
        markerUnits: "strokeWidth",
      });
      defs.appendChild(marker);
    }
    const refX = spec.refX;
    marker.setAttribute("refX", String(refX));
    marker.setAttribute("refY", String(Number(spec.box.split(" ")[3]) / 2));
    let body = marker.querySelector("path");
    if (!body) {
      body = el("path");
      marker.appendChild(body);
    }
    setAttrs(body, { d: spec.body, fill: spec.fill, stroke: spec.stroke, "stroke-width": 1.4 });
  }
}

/** Rounds to 2 decimals: keeps the serialised SVG readable and diffable. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export { round as r2 };

/**
 * Next free `<prefix><n>` id.
 *
 * Ids only have to be unique inside one chart's model — they are never written
 * to the file — so a monotonic counter over the existing set is enough, and it
 * keeps a re-parse of hand-written mermaid stable.
 */
export function nextId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  let index = used.size + 1;
  let candidate = `${prefix}${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${prefix}${index}`;
  }
  return candidate;
}
