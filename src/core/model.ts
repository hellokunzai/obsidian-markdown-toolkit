/**
 * Core graph model.
 *
 * Deliberately free of any Obsidian import: everything in `src/core` is a pure
 * function over plain data and can be unit tested outside the app.
 */

/**
 * The two kinds that share the generic "nodes joined by edges" canvas.
 *
 * `mindmap` and `flow` are not diagram types here so much as *canvas* types:
 * both are a handful of boxes connected by lines, so one editor — one model,
 * one drag handler, one serializer — draws both. Everything that reads
 * `model.mode` is asking which of these two shapes it is looking at.
 */
export type CanvasMode = "mindmap" | "flow";

/**
 * The kinds with a canvas of their own.
 *
 * A sequence diagram is columns and rows; a pie chart is sectors; a gantt chart
 * is bars on a time axis. None of them is "nodes joined by edges", so each gets
 * its own layout and its own drag semantics rather than being flattened into a
 * graph it is not. They share the surrounding machinery — viewport, undo,
 * selection, save, export — through `src/charts`.
 */
export type ChartCanvasId =
  | "state"
  | "class"
  | "er"
  | "sequence"
  | "gantt"
  | "pie"
  | "gitGraph"
  | "timeline"
  | "ishikawa";

/**
 * Every kind that can be opened in a visual editor, keyed by the kind's id.
 *
 * This is deliberately the same string as `DiagramKind.id`: the block locator
 * matches a fenced block by comparing this value (see `block-target.ts`), so
 * sharing the vocabulary means one diagram kind can never be mistaken for
 * another when the note has several of them in a row.
 */
export type DiagramMode = CanvasMode | ChartCanvasId;

/** True for the kinds the generic node-and-edge canvas draws. */
export function isCanvasMode(mode: DiagramMode): mode is CanvasMode {
  return mode === "mindmap" || mode === "flow";
}

export type NodeShape = "rect" | "stadium" | "circle" | "diamond" | "hexagon";

/** Layout direction of a flowchart, mirroring `flowchart TD` syntax. */
export type FlowDirection = "TD" | "BT" | "LR" | "RL";

/** Growth direction of a mind map. */
export type MindmapLayout = "right" | "left" | "both";

export interface Point {
  x: number;
  y: number;
}

export interface DiagramNode {
  /** Internal identity, unique per model. Never written to the file. */
  id: string;
  /** Explicit mermaid id (`root` in `root((text))`), mind map only. */
  alias: string;
  text: string;
  shape: NodeShape;
  x: number;
  y: number;
  /**
   * Stable key used inside the layout annotation and as the round trip anchor.
   * Mind map: the tree path (`0.1.2`), because the syntax carries no ids.
   * Flowchart: the mermaid node id, which is stable across edits.
   */
  key: string;
  /** Outline level, mind map only. Kept so serialisation can rebuild indentation. */
  depth: number;
  /**
   * Set as soon as the user drags a node. Only pinned nodes are written to the
   * coordinate annotation, so a diagram nobody has touched leaves the file clean.
   */
  pinned?: boolean;
}

/**
 * The one fence language every diagram lives in.
 *
 * Deliberately not configurable. Markdown's convention is that a diagram is a
 * ```mermaid block, whichever kind it is, and the kind is declared by the
 * body's first line (`mindmap`, `flowchart TD`, …). Inventing a private
 * language name would make the note unreadable to every other mermaid
 * renderer, which is the opposite of the point.
 */
export const MERMAID_LANG = "mermaid";

/**
 * Comment marker of the coordinate annotation stored inside the fenced block.
 *
 * `%%` is a comment in every mermaid diagram type, so a renderer that does not
 * know about the plugin skips the line instead of failing on it.
 */
export const LAYOUT_ANNOTATION = "markdown-toolkit:layout";

/**
 * Every annotation token an earlier release has already written into notes,
 * newest first.
 *
 * Two renames have happened, so a note in the wild can carry either of these.
 * Each entry is frozen on purpose: a token a released version wrote into user
 * files cannot be renamed again without orphaning those files, and appending
 * the outgoing token here is the whole cost of a future rename.
 *
 * Read, never written. A note that already carries an old line keeps the
 * positions the user dragged, instead of silently falling back to the
 * automatic layout the next time that block is saved. The line is rewritten
 * under the current token the first time the block is edited, so notes migrate
 * themselves one at a time and nothing is lost in the meantime.
 */
export const LEGACY_LAYOUT_ANNOTATIONS: readonly string[] = [
  "markdown-editor-plus:layout", // 0.17.0
  "mindforge:layout", // up to 0.16.0
];

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  /** Routed polyline in model coordinates, filled in by the flow layout. */
  route?: Point[];
}

export interface DiagramModel {
  /**
   * Which node-and-edge canvas this is.
   *
   * Deliberately `CanvasMode` and not `DiagramMode`: this model *is* the
   * node-and-edge shape, so a chart kind is not something it could describe.
   * The narrower type is what stops a gantt chart from being handed to the
   * flowchart parser and quietly producing an empty graph.
   */
  mode: CanvasMode;
  direction: FlowDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /**
   * Lines the parser does not model (`classDef`, `style`, `click`, …).
   * They are echoed back verbatim so editing a diagram never destroys them.
   */
  passthrough: string[];
  /** Manual positions read from the layout annotation, keyed by node key. */
  positions: Record<string, Point>;
}

export function createModel(mode: CanvasMode): DiagramModel {
  return {
    mode,
    direction: mode === "flow" ? "TD" : "TD",
    nodes: [],
    edges: [],
    passthrough: [],
    positions: {},
  };
}

export function cloneModel(model: DiagramModel): DiagramModel {
  return {
    mode: model.mode,
    direction: model.direction,
    nodes: model.nodes.map((n) => ({ ...n })),
    edges: model.edges.map((e) => ({
      ...e,
      route: e.route ? e.route.map((p) => ({ ...p })) : undefined,
    })),
    passthrough: model.passthrough.slice(),
    positions: { ...model.positions },
  };
}

export function nodeById(model: DiagramModel, id: string): DiagramNode | null {
  for (const node of model.nodes) if (node.id === id) return node;
  return null;
}

export function nodeByKey(model: DiagramModel, key: string): DiagramNode | null {
  for (const node of model.nodes) if (node.key === key) return node;
  return null;
}

/** Nodes that no edge points at — the roots of a mind map, the sources of a flow. */
export function rootNodes(model: DiagramModel): DiagramNode[] {
  const targeted = new Set(model.edges.map((e) => e.to));
  const roots = model.nodes.filter((n) => !targeted.has(n.id));
  return roots.length ? roots : model.nodes.slice(0, 1);
}

export function childrenOf(model: DiagramModel, id: string): DiagramNode[] {
  const out: DiagramNode[] = [];
  for (const edge of model.edges) {
    if (edge.from !== id) continue;
    const child = nodeById(model, edge.to);
    if (child) out.push(child);
  }
  return out;
}

export function parentOf(model: DiagramModel, id: string): DiagramNode | null {
  for (const edge of model.edges) if (edge.to === id) return nodeById(model, edge.from);
  return null;
}

export function isRoot(model: DiagramModel, id: string): boolean {
  return !model.edges.some((e) => e.to === id);
}

/** Next free id for a generated node, avoiding collisions with existing ids. */
export function nextNodeId(model: DiagramModel, seed = "n"): string {
  const taken = new Set(model.nodes.map((n) => n.id));
  let index = model.nodes.length + 1;
  let candidate = `${seed}${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${seed}${index}`;
  }
  return candidate;
}
