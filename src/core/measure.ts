import type { DiagramModel, DiagramNode, NodeShape } from "./model";

export interface Size {
  w: number;
  h: number;
}

/**
 * Text metrics.
 *
 * We cannot use `getBBox()` during layout: layout runs for nodes that are not in
 * the DOM yet, and the flow layout must be deterministic before rendering. So node
 * sizes come from a character-width estimate. Wide glyphs (CJK, full width forms,
 * Hangul) count as two units, everything else as one.
 */
const UNIT_PX = 6.9;
const LINE_HEIGHT = 19;
const PAD_X = 26;
const PAD_Y = 18;
const MIN_W = 58;
const MAX_LINE_UNITS = 30;
const MAX_LINES = 3;

function isWide(code: number): boolean {
  return (
    (code > 0x2e80 && code < 0xa000) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function textUnits(text: string): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) units += isWide(text.charCodeAt(i)) ? 2 : 1;
  return units;
}

/**
 * Greedy wrap by display width, at most `MAX_LINES` lines. The last line absorbs
 * the remainder instead of being clipped, so no text is ever silently dropped.
 */
export function wrapLabel(text: string, maxUnits = MAX_LINE_UNITS, maxLines = MAX_LINES): string[] {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source) return [""];
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const ch of Array.from(source)) {
    const unit = isWide(ch.charCodeAt(0)) ? 2 : 1;
    if (width + unit > maxUnits && current) {
      lines.push(current);
      current = "";
      width = 0;
      if (lines.length === maxLines - 1) break;
    }
    current += ch;
    width += unit;
  }
  const consumed = lines.join("").length;
  const rest = consumed ? source.slice(consumed) : source;
  lines.push(rest);
  return lines.slice(0, maxLines);
}

export function measureNode(node: Pick<DiagramNode, "text" | "shape">): Size {
  const lines = wrapLabel(node.text);
  const widest = lines.reduce((max, line) => Math.max(max, textUnits(line)), 0);
  let w = Math.max(MIN_W, Math.round(widest * UNIT_PX) + PAD_X);
  let h = lines.length * LINE_HEIGHT + PAD_Y;

  if (node.shape === "circle") {
    const d = Math.max(66, w, h);
    return { w: d, h: d };
  }
  if (node.shape === "diamond") {
    w = Math.round(w * 1.34);
    h = Math.round(h * 1.6);
  }
  return { w, h };
}

export function measureLines(node: Pick<DiagramNode, "text">): string[] {
  return wrapLabel(node.text);
}

/** Half-open bounding box of every node, or `null` for an empty model. */
export function modelBounds(
  model: DiagramModel,
  measure: (node: Pick<DiagramNode, "text" | "shape">) => Size = measureNode
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!model.nodes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const node of model.nodes) {
    const size = measure(node);
    x1 = Math.min(x1, node.x - size.w / 2);
    y1 = Math.min(y1, node.y - size.h / 2);
    x2 = Math.max(x2, node.x + size.w / 2);
    y2 = Math.max(y2, node.y + size.h / 2);
  }
  return { x1, y1, x2, y2 };
}

export function shapeLabelKey(shape: NodeShape): string {
  return `editor.shape.${shape}`;
}
