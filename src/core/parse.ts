import {
  createModel,
  LAYOUT_ANNOTATION,
  LEGACY_LAYOUT_ANNOTATIONS,
  type CanvasMode,
  type DiagramEdge,
  type DiagramMode,
  type DiagramModel,
  type DiagramNode,
  type FlowDirection,
  type NodeShape,
  type Point,
} from "./model";
import { detectKind, FLOW_HEADER_RE } from "./kinds";

export interface ParseResult {
  model: DiagramModel;
  /**
   * Lines the parser could not model. They are kept in `model.passthrough` and
   * echoed back on save, so an edit never silently deletes syntax we do not
   * understand. The list is also surfaced in the editor status line.
   */
  issues: string[];
  /** True when at least one node was recognised. */
  ok: boolean;
}

/* ------------------------------------------------------------------ shared */

const SHAPE_PATTERNS: Array<[RegExp, NodeShape]> = [
  [/^([A-Za-z0-9_-]+)\s*\(\(([\s\S]*)\)\)$/, "circle"],
  [/^([A-Za-z0-9_-]+)\s*\(\[([\s\S]*)\]\)$/, "stadium"],
  [/^([A-Za-z0-9_-]+)\s*\{\{([\s\S]*)\}\}$/, "hexagon"],
  [/^([A-Za-z0-9_-]+)\s*\[([\s\S]*)\]$/, "rect"],
  [/^([A-Za-z0-9_-]+)\s*\{([\s\S]*)\}$/, "diamond"],
  [/^([A-Za-z0-9_-]+)\s*\(([\s\S]*)\)$/, "stadium"],
];

/**
 * Mind map items carry no id, so the alias is optional here. Missing it is the
 * common case (`  思维导图`) and must not turn the whole token into an alias.
 */
const MINDMAP_PATTERNS: Array<[RegExp, NodeShape]> = [
  [/^([A-Za-z0-9_-]*)\s*\(\(([\s\S]*)\)\)$/, "circle"],
  [/^([A-Za-z0-9_-]*)\s*\(\[([\s\S]*)\]\)$/, "stadium"],
  [/^([A-Za-z0-9_-]*)\s*\{\{([\s\S]*)\}\}$/, "hexagon"],
  [/^([A-Za-z0-9_-]*)\s*\[([\s\S]*)\]$/, "rect"],
  [/^([A-Za-z0-9_-]*)\s*\(([\s\S]*)\)$/, "stadium"],
];

const ARROW_SPLIT = /\s*(?:-{2,3}>|-\.->|={2}>|--[xo]|-{3,})\s*(?:\|\s*("[^"]*"|[^|]*?)\s*\|)?\s*/;
const PASSTHROUGH_RE = /^(classDef|class|style|linkStyle|click|subgraph|end|direction)\b/;
/**
 * The current token, followed by every token an earlier release wrote.
 *
 * The current one is listed first only because that reads better; the regexes
 * are mutually exclusive, so the order never decides a match. Composed from the
 * constants rather than spelled out again, so the on-disk format keeps exactly
 * one source of truth (`LAYOUT_ANNOTATION` in `model.ts`).
 */
const ANNOTATION_TOKENS = [LAYOUT_ANNOTATION, ...LEGACY_LAYOUT_ANNOTATIONS];
const ANNOTATION_RES = ANNOTATION_TOKENS.map(
  (token) => new RegExp(`^%%\\s*${token}\\s+(.*)$`)
);

export function isLayoutAnnotation(line: string): boolean {
  const trimmed = line.trim();
  return (
    ANNOTATION_TOKENS.some((token) => trimmed.indexOf(`%% ${token}`) === 0) ||
    ANNOTATION_RES.some((re) => re.test(trimmed))
  );
}

/**
 * Parse a layout annotation into `positions`. Returns true if matched.
 *
 * Accepts the current token and every legacy one; which token a note carries
 * only says when it was last saved, not what it means.
 */
function readLayoutAnnotation(line: string, positions: Record<string, Point>): boolean {
  const trimmed = line.trim();
  let match: RegExpExecArray | null = null;
  for (const re of ANNOTATION_RES) {
    match = re.exec(trimmed);
    if (match) break;
  }
  if (!match) return false;
  for (const pair of match[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const xy = pair.slice(eq + 1).split(",");
    if (xy.length !== 2) continue;
    const x = Number.parseFloat(xy[0]);
    const y = Number.parseFloat(xy[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) positions[pair.slice(0, eq)] = { x, y };
  }
  return true;
}

/** Strips mermaid quoting and inline HTML artifacts from a label. */
export function cleanLabel(raw: string): string {
  let text = String(raw).trim();
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return text.replace(/#quot;/g, '"').replace(/<br\s*\/?>/gi, " ").trim();
}

function parseNodeSpec(spec: string): { id: string; shape: NodeShape; text: string } | null {
  const trimmed = spec.trim();
  for (const [re, shape] of SHAPE_PATTERNS) {
    const match = re.exec(trimmed);
    if (match) return { id: match[1], shape, text: cleanLabel(match[2]) };
  }
  const bare = /^([A-Za-z0-9_-]+)$/.exec(trimmed);
  if (bare) return { id: bare[1], shape: "rect", text: bare[1] };
  return null;
}

/* ------------------------------------------------------------------- flow */

export function parseFlow(text: string): ParseResult {
  const model = createModel("flow");
  const issues: string[] = [];
  let seenHeader = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (!seenHeader) {
      const header = FLOW_HEADER_RE.exec(line);
      if (header) {
        const direction = header[1].toUpperCase();
        model.direction = (direction === "TB" ? "TD" : direction) as FlowDirection;
        seenHeader = true;
        continue;
      }
    }
    if (readLayoutAnnotation(line, model.positions)) continue;
    if (line.startsWith("%%") || PASSTHROUGH_RE.test(line)) {
      model.passthrough.push(line);
      continue;
    }

    const parts = line.split(ARROW_SPLIT);
    const specs: string[] = [];
    const labels: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) specs.push(parts[i]);
      else labels.push(parts[i]);
    }

    let previous: DiagramNode | null = null;
    let labelIndex = 0;
    let recognised = true;

    for (const spec of specs) {
      if (!spec || !spec.trim()) {
        recognised = false;
        break;
      }
      const parsed = parseNodeSpec(spec);
      if (!parsed) {
        recognised = false;
        break;
      }
      let node = model.nodes.find((n) => n.id === parsed.id) ?? null;
      if (!node) {
        node = {
          id: parsed.id,
          alias: parsed.id,
          text: parsed.text,
          shape: parsed.shape,
          x: 0,
          y: 0,
          key: parsed.id,
          depth: 0,
        };
        model.nodes.push(node);
      } else if (parsed.text && parsed.text !== parsed.id && parsed.text !== node.text) {
        // A later mention with an explicit label wins, matching mermaid's own
        // "last definition of the shape wins" behaviour.
        node.text = parsed.text;
        node.shape = parsed.shape;
      }
      if (previous) {
        const rawLabel = labels[labelIndex] ?? "";
        model.edges.push({
          id: `e${model.edges.length + 1}`,
          from: previous.id,
          to: node.id,
          label: rawLabel ? cleanLabel(rawLabel) : "",
        });
        labelIndex++;
      }
      previous = node;
    }

    if (!recognised) {
      issues.push(line);
      model.passthrough.push(line);
    }
  }

  return { model, issues, ok: model.nodes.length > 0 };
}

/* ---------------------------------------------------------------- mindmap */

export function parseMindmap(text: string): ParseResult {
  const model = createModel("mindmap");
  const issues: string[] = [];
  const lines = text.split(/\r?\n/);

  let inBody = false;
  let minIndent = Number.POSITIVE_INFINITY;
  const items: Array<{ indent: number; spec: string }> = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (!inBody) {
      if (/^mindmap\b/i.test(raw.trim())) inBody = true;
      continue;
    }
    const trimmed = raw.trim();
    if (readLayoutAnnotation(trimmed, model.positions)) continue;
    if (trimmed.startsWith("%%")) {
      model.passthrough.push(trimmed);
      continue;
    }
    const indent = (raw.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "  ").length;
    if (indent < minIndent) minIndent = indent;
    items.push({ indent, spec: trimmed });
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  // First pass: build nodes, deriving a stable tree path as the key.
  const childCount = new Map<string, number>();
  const depthPath: string[] = [];
  let seq = 0;

  for (const item of items) {
    const depth = Math.max(0, Math.round((item.indent - minIndent) / 2));
    let shape: NodeShape = "rect";
    let text = item.spec;
    let alias = "";
    for (const [re, candidate] of MINDMAP_PATTERNS) {
      const match = re.exec(item.spec);
      if (match) {
        shape = candidate;
        alias = match[1];
        text = match[2];
        break;
      }
    }
    const label = cleanLabel(text);
    if (!label && !item.spec.trim()) continue;

    const parentPath = depth > 0 ? depthPath[depth - 1] ?? "" : "";
    const index = (childCount.get(parentPath) ?? 0) + 1;
    childCount.set(parentPath, index);
    const path = parentPath ? `${parentPath}.${index}` : String(index);
    depthPath[depth] = path;
    seq += 1;

    model.nodes.push({
      id: `m${seq}`,
      alias,
      text: label || " ",
      shape,
      x: 0,
      y: 0,
      key: path,
      depth,
    });
  }

  // Second pass: wire parents by path, so the edges follow the tree we just built.
  const byPath = new Map(model.nodes.map((n) => [n.key, n]));
  for (const node of model.nodes) {
    const cut = node.key.lastIndexOf(".");
    if (cut < 0) continue;
    const parent = byPath.get(node.key.slice(0, cut));
    if (!parent) continue;
    model.edges.push({
      id: `e${model.edges.length + 1}`,
      from: parent.id,
      to: node.id,
      label: "",
    });
  }

  return { model, issues, ok: model.nodes.length > 0 };
}

/* -------------------------------------------------------------- dispatcher */

/**
 * The canvas mode for a body, or `null` when no canvas can open it.
 *
 * Every kind in `DIAGRAM_KINDS` answers now — the table is the list of kinds
 * this plugin understands, and each of them has a canvas. `null` therefore
 * means "not a diagram we know", which is what turns a `quadrantChart` into
 * "hand this to mermaid" rather than into a broken diagram.
 */
export function detectMode(text: string): DiagramMode | null {
  return detectKind(text)?.mode ?? null;
}

/**
 * Parse a body as a node-and-edge diagram.
 *
 * Takes a `CanvasMode`, not a `DiagramMode`: this parser only knows the two
 * kinds that are boxes joined by lines, and the narrower parameter is what
 * makes passing a chart kind a compile error instead of a silently empty
 * graph. Chart kinds go through their own `ChartSpec.parse`.
 */
export function parseDiagram(text: string, fallback: CanvasMode): ParseResult {
  const declared = detectMode(text);
  return declared === "mindmap" || (!declared && fallback === "mindmap")
    ? parseMindmap(text)
    : parseFlow(text);
}

/** Rewires every `key` from the model's node coordinates, refreshing pin flags. */
export function applyPinnedPositions(model: DiagramModel): void {
  for (const node of model.nodes) {
    const point = model.positions[node.key];
    if (!point) {
      node.pinned = false;
      continue;
    }
    node.x = point.x;
    node.y = point.y;
    node.pinned = true;
  }
}

export function pinnedPositions(model: DiagramModel): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const node of model.nodes) {
    if (node.pinned) out[node.key] = { x: Math.round(node.x), y: Math.round(node.y) };
  }
  return out;
}

export type { DiagramEdge, DiagramNode };
