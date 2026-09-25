import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { measureNode } from "./measure";
import type { DiagramModel, Point } from "./model";

/**
 * Layered layout for flowcharts, delegated to dagre — the same engine mermaid
 * uses. It brings two things a hand-rolled layer pass cannot: dummy nodes, so a
 * long edge routes around the ranks it skips, and proper crossing minimisation,
 * so a fan-out of five branches does not turn into a pile of diagonal crossings.
 */

const NODE_SEP = 26;
const RANK_SEP = 56;
const EDGE_SEP = 14;

export function layoutFlow(model: DiagramModel): void {
  if (!model.nodes.length) return;

  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: model.direction || "TD",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    edgesep: EDGE_SEP,
    marginx: 12,
    marginy: 12,
    ranker: "network-simplex",
    acyclicer: "greedy",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of model.nodes) {
    const size = measureNode(node);
    graph.setNode(node.id, { width: size.w, height: size.h });
  }
  // Parallel edges (`a --> b` twice) are legitimate in mermaid, so the graph is
  // a multigraph and the edge id doubles as the edge name.
  for (const edge of model.edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    graph.setEdge(edge.from, edge.to, { id: edge.id }, edge.id);
  }

  dagreLayout(graph);

  for (const node of model.nodes) {
    const label = graph.node(node.id) as { x?: number; y?: number } | undefined;
    if (!label || typeof label.x !== "number" || typeof label.y !== "number") continue;
    if (node.pinned) continue;
    node.x = label.x;
    node.y = label.y;
  }

  const pinned = new Set(model.nodes.filter((n) => n.pinned).map((n) => n.id));
  for (const edge of model.edges) {
    const points = graph.edge({ v: edge.from, w: edge.to, name: edge.id })?.points as Point[] | undefined;
    if (!points || points.length < 2 || pinned.has(edge.from) || pinned.has(edge.to)) {
      // A hand-moved endpoint invalidates the routed polyline, so the renderer
      // falls back to an elbow it computes from the current coordinates.
      edge.route = undefined;
      continue;
    }
    edge.route = points.map((p) => ({ x: p.x, y: p.y }));
  }
}
