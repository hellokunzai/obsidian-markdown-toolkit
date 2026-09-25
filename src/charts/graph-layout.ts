import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import type { FlowDirection, Point } from "../core/model";

/**
 * Layered layout, delegated to dagre — the same engine mermaid uses.
 *
 * Shared by the three chart kinds that really are boxes joined by lines (state,
 * class, ER). It brings two things a hand-rolled layer pass cannot: dummy nodes,
 * so a long edge routes around the ranks it skips, and crossing minimisation, so
 * a fan-out of five branches does not collapse into a pile of diagonals.
 */

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
  /** Pinned nodes keep their coordinates; dagre still reserves the space. */
  pinned?: boolean;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
}

export interface GraphLayout {
  /** Centre point per node id. Missing for nodes dagre could not place. */
  positions: Map<string, Point>;
  /** Routed polyline per edge id, when dagre produced one. */
  routes: Map<string, Point[]>;
}

export interface GraphLayoutOptions {
  direction?: FlowDirection;
  nodeSep?: number;
  rankSep?: number;
}

export function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: GraphLayoutOptions = {}
): GraphLayout {
  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();
  if (!nodes.length) return { positions, routes };

  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: options.direction ?? "TD",
    nodesep: options.nodeSep ?? 34,
    ranksep: options.rankSep ?? 58,
    edgesep: 14,
    marginx: 16,
    marginy: 16,
    ranker: "network-simplex",
    acyclicer: "greedy",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((n) => n.id));
  for (const node of nodes) graph.setNode(node.id, { width: node.w, height: node.h });
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    // Parallel edges are legitimate here (`A --> B` twice), so the edge id
    // doubles as the multigraph edge name.
    graph.setEdge(edge.from, edge.to, { id: edge.id }, edge.id);
  }

  dagreLayout(graph);

  for (const node of nodes) {
    const label = graph.node(node.id) as { x?: number; y?: number } | undefined;
    if (!label || typeof label.x !== "number" || typeof label.y !== "number") continue;
    positions.set(node.id, { x: label.x, y: label.y });
  }

  const endpoints = new Map<string, [string, string]>(
    edges.map((edge) => [edge.id, [edge.from, edge.to]])
  );
  for (const edge of edges) {
    const points = graph.edge({ v: edge.from, w: edge.to, name: edge.id })?.points as Point[] | undefined;
    if (!points || points.length < 2) continue;
    // A hand-moved endpoint invalidates the routed polyline, so the renderer
    // falls back to an elbow computed from the current coordinates.
    const ends = endpoints.get(edge.id);
    if (ends && nodes.some((n) => n.pinned && (n.id === ends[0] || n.id === ends[1]))) continue;
    routes.set(edge.id, points.map((p) => ({ x: p.x, y: p.y })));
  }

  return { positions, routes };
}

/** Straight or elbow path between two boxes, used when dagre has no route. */
export function elbowPath(from: Point, to: Point, flow: FlowDirection = "TD"): string {
  if (flow === "LR" || flow === "RL") {
    const mid = (from.x + to.x) / 2;
    return `M${from.x} ${from.y} L${mid} ${from.y} L${mid} ${to.y} L${to.x} ${to.y}`;
  }
  const mid = (from.y + to.y) / 2;
  return `M${from.x} ${from.y} L${from.x} ${mid} L${to.x} ${mid} L${to.x} ${to.y}`;
}

export function polylinePath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}

/** Where to put an edge label: the midpoint of its route, or of the straight run. */
export function routeMidpoint(points: Point[] | undefined, fallbackFrom: Point, fallbackTo: Point): Point {
  const list = points && points.length >= 2 ? points : [fallbackFrom, fallbackTo];
  const mid = Math.floor(list.length / 2);
  if (list.length % 2 === 1) return list[mid];
  const a = list[mid - 1];
  const b = list[mid];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
