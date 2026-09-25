import { edgeGeometry } from "../core/routing";
import { measureLines, measureNode } from "../core/measure";
import { isRoot, type DiagramModel, type DiagramNode } from "../core/model";

/**
 * SVG rendering.
 *
 * Every element is built with `createElementNS` and every paint property is set
 * as a presentation attribute — never `innerHTML`, never `style.* = "literal"`.
 * Two reasons, both load-bearing:
 *  - `innerHTML` with a node label in it is a code-injection hole; labels are
 *    arbitrary user text.
 *  - presentation attributes survive being serialised into an exported `.svg`,
 *    where the plugin's stylesheet is not present.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const MARKER_ID = "mtk-arrow";

export interface Palette {
  edge: string;
  edgeText: string;
  surface: string;
  accent: string;
  fill: string;
  stroke: string;
  text: string;
  rootFill: string;
  rootStroke: string;
  rootText: string;
}

const FALLBACK: Palette = {
  edge: "#98a2ae",
  edgeText: "#6b7480",
  surface: "#ffffff",
  accent: "#7c5cff",
  fill: "#e8f1fe",
  stroke: "#77aaf0",
  text: "#123a6b",
  rootFill: "#efeaff",
  rootStroke: "#8f79ff",
  rootText: "#3a2a8c",
};

function readVar(style: CSSStyleDeclaration, names: string[]): string {
  for (const name of names) {
    const value = style.getPropertyValue(name);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

/** Resolves the palette from the CSS custom properties, with theme fallbacks. */
export function readPalette(from: Element): Palette {
  const style = getComputedStyle(from);
  const pick = (name: string, obsidianVar: string, fallback: string): string =>
    readVar(style, [`--mtk-${name}`, obsidianVar]) || fallback;
  return {
    edge: pick("edge", "--text-faint", FALLBACK.edge),
    edgeText: pick("edge-text", "--text-muted", FALLBACK.edgeText),
    surface: pick("surface", "--background-primary", FALLBACK.surface),
    accent: pick("accent", "--interactive-accent", FALLBACK.accent),
    fill: pick("node-fill", "--background-secondary", FALLBACK.fill),
    stroke: pick("node-stroke", "--background-modifier-border", FALLBACK.stroke),
    text: pick("node-text", "--text-normal", FALLBACK.text),
    rootFill: pick("root-fill", "--background-secondary-alt", FALLBACK.rootFill),
    rootStroke: pick("root-stroke", "--background-modifier-border-hover", FALLBACK.rootStroke),
    rootText: pick("root-text", "--text-normal", FALLBACK.rootText),
  };
}

export interface DiagramSurface {
  svg: SVGSVGElement;
  layer: SVGGElement;
}

export function createSvgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export function setAttrs(node: Element, values: Record<string, string | number | undefined>): void {
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined) continue;
    node.setAttribute(key, String(value));
  }
}

/** `<svg>` + arrow marker `<defs>` + a transformable layer. */
export function createSurface(parent: HTMLElement, extraClass = ""): DiagramSurface {
  const svg = createSvgEl("svg");
  svg.classList.add("mtk-svg");
  if (extraClass) svg.classList.add(extraClass);
  svg.setAttribute("xmlns", SVG_NS);

  const defs = createSvgEl("defs");
  const marker = createSvgEl("marker");
  setAttrs(marker, {
    id: MARKER_ID,
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: "auto-start-reverse",
    markerUnits: "strokeWidth",
  });
  const markerPath = createSvgEl("path");
  setAttrs(markerPath, { d: "M0 0 L10 5 L0 10 z" });
  marker.appendChild(markerPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const layer = createSvgEl("g");
  layer.classList.add("mtk-layer");
  svg.appendChild(layer);
  parent.appendChild(svg);

  return { svg, layer };
}

export interface RenderOptions {
  /** Adds selection halo and connection ports. */
  interactive: boolean;
  selectedId: string | null;
}

function shapeFor(
  node: DiagramNode,
  w: number,
  h: number,
  fill: string,
  stroke: string
): SVGElement {
  const x = node.x - w / 2;
  const y = node.y - h / 2;
  const common = { fill, stroke, "stroke-width": 1, "vector-effect": "non-scaling-stroke" };

  if (node.shape === "circle") {
    const ellipse = createSvgEl("ellipse");
    setAttrs(ellipse, { cx: node.x, cy: node.y, rx: w / 2, ry: h / 2, ...common });
    return ellipse;
  }
  if (node.shape === "diamond") {
    const polygon = createSvgEl("polygon");
    setAttrs(polygon, {
      points: `${node.x},${y} ${x + w},${node.y} ${node.x},${y + h} ${x},${node.y}`,
      ...common,
    });
    return polygon;
  }
  if (node.shape === "hexagon") {
    const cut = Math.min(14, w / 5);
    const polygon = createSvgEl("polygon");
    setAttrs(polygon, {
      points:
        `${x + cut},${y} ${x + w - cut},${y} ${x + w},${node.y} ` +
        `${x + w - cut},${y + h} ${x + cut},${y + h} ${x},${node.y}`,
      ...common,
    });
    return polygon;
  }
  const rect = createSvgEl("rect");
  setAttrs(rect, {
    x,
    y,
    width: w,
    height: h,
    rx: node.shape === "stadium" ? Math.round(h / 2) : 9,
    ...common,
  });
  return rect;
}

function labelFor(node: DiagramNode, w: number, color: string): SVGElement {
  const lines = measureLines(node);
  const text = createSvgEl("text");
  text.classList.add("mtk-node-label");
  setAttrs(text, {
    x: node.x,
    y: node.y,
    "text-anchor": "middle",
    "dominant-baseline": "central",
    "font-size": 13,
    fill: color,
  });
  const step = 19;
  const first = -((lines.length - 1) * step) / 2;
  lines.forEach((line, index) => {
    const tspan = createSvgEl("tspan");
    setAttrs(tspan, { x: node.x, y: node.y + first + index * step });
    // Long labels are clamped to the measured width, so a stray glyph cannot
    // poke out of its own box.
    tspan.textContent = line.length > 42 ? `${line.slice(0, 41)}…` : line;
    text.appendChild(tspan);
  });
  void w;
  return text;
}

export function renderDiagram(
  surface: DiagramSurface,
  model: DiagramModel,
  options: RenderOptions,
  palette?: Palette
): void {
  const colors = palette ?? readPalette(surface.svg);
  const markerPath = surface.svg.querySelector(`#${MARKER_ID} path`);
  if (markerPath) setAttrs(markerPath, { fill: colors.edge });

  const fragment = document.createDocumentFragment();

  for (const edge of model.edges) {
    const geometry = edgeGeometry(model, edge);
    if (!geometry) continue;
    const path = createSvgEl("path");
    setAttrs(path, {
      d: geometry.d,
      fill: "none",
      stroke: colors.edge,
      "stroke-width": 1.2,
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    });
    if (model.mode === "flow") path.setAttribute("marker-end", `url(#${MARKER_ID})`);
    fragment.appendChild(path);

    if (edge.label) {
      const text = createSvgEl("text");
      setAttrs(text, {
        x: geometry.labelAt.x,
        y: geometry.labelAt.y - 7,
        "text-anchor": "middle",
        "font-size": 11.5,
        fill: colors.edgeText,
        stroke: colors.surface,
        "stroke-width": 3.5,
        "paint-order": "stroke",
      });
      text.textContent = edge.label;
      fragment.appendChild(text);
    }
  }

  for (const node of model.nodes) {
    const size = measureNode(node);
    const root = model.mode === "mindmap" && isRoot(model, node.id);
    const fill = root ? colors.rootFill : colors.fill;
    const stroke = root ? colors.rootStroke : colors.stroke;
    const textColor = root ? colors.rootText : colors.text;

    const group = createSvgEl("g");
    group.classList.add("mtk-node");
    group.dataset.node = node.id;
    if (options.interactive) group.classList.add("mtk-node-interactive");

    if (options.interactive && options.selectedId === node.id) {
      const halo = createSvgEl("rect");
      setAttrs(halo, {
        x: node.x - size.w / 2 - 5,
        y: node.y - size.h / 2 - 5,
        width: size.w + 10,
        height: size.h + 10,
        rx: 11,
        fill: "none",
        stroke: colors.accent,
        "stroke-width": 1,
        "stroke-dasharray": "4 3",
        "vector-effect": "non-scaling-stroke",
      });
      group.appendChild(halo);
    }

    group.appendChild(shapeFor(node, size.w, size.h, fill, stroke));
    group.appendChild(labelFor(node, size.w, textColor));

    if (options.interactive) {
      const port = createSvgEl("circle");
      port.classList.add("mtk-port");
      setAttrs(port, {
        "data-port": node.id,
        cx: node.x + size.w / 2 + 12,
        cy: node.y,
        r: 6.5,
        fill: colors.surface,
        stroke: colors.accent,
        "stroke-width": 1.2,
        "vector-effect": "non-scaling-stroke",
      });
      group.appendChild(port);
    }

    fragment.appendChild(group);
  }

  surface.layer.replaceChildren(fragment);
}

/** Size of the drawing in model coordinates. */
export function modelExtent(model: DiagramModel): { w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    const size = measureNode(node);
    minX = Math.min(minX, node.x - size.w / 2);
    minY = Math.min(minY, node.y - size.h / 2);
    maxX = Math.max(maxX, node.x + size.w / 2);
    maxY = Math.max(maxY, node.y + size.h / 2);
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}
