import { measureNode } from "./measure";
import { nodeById, type DiagramModel, type DiagramEdge, type DiagramNode, type Point } from "./model";

/**
 * Edge geometry.
 *
 * Kept apart from the SVG renderer on purpose: the flow layout, the renderer and
 * the export path all need the same answer to "where does this line start, where
 * does it end, and where does its label go", and three copies of that maths is
 * three places for the drawing to disagree with itself.
 */

export interface EdgeGeometry {
  /** `d` attribute of the `<path>`. */
  d: string;
  labelAt: Point;
  /** True when the edge leaves and enters horizontally. */
  horizontal: boolean;
}

function anchorPair(
  model: DiagramModel,
  a: DiagramNode,
  b: DiagramNode
): { p1: Point; p2: Point; horizontal: boolean } {
  const sizeA = measureNode(a);
  const sizeB = measureNode(b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let horizontal: boolean;
  if (model.mode === "mindmap") horizontal = true;
  else if (model.direction === "LR" || model.direction === "RL") horizontal = true;
  else if (model.direction === "TD" || model.direction === "BT") horizontal = false;
  else horizontal = Math.abs(dx) >= Math.abs(dy);

  if (horizontal) {
    const sign = dx >= 0 ? 1 : -1;
    return {
      p1: { x: a.x + (sign * sizeA.w) / 2, y: a.y },
      p2: { x: b.x - (sign * sizeB.w) / 2, y: b.y },
      horizontal: true,
    };
  }
  const sign = dy >= 0 ? 1 : -1;
  return {
    p1: { x: a.x, y: a.y + (sign * sizeA.h) / 2 },
    p2: { x: b.x, y: b.y - (sign * sizeB.h) / 2 },
    horizontal: false,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Two-segment elbow used when dagre's routed points are unusable. */
export function elbowRoute(from: Point, to: Point, horizontal: boolean): Point[] {
  if (horizontal) {
    const mid = (from.x + to.x) / 2;
    return [from, { x: mid, y: from.y }, { x: mid, y: to.y }, to];
  }
  const mid = (from.y + to.y) / 2;
  return [from, { x: from.x, y: mid }, { x: to.x, y: mid }, to];
}

/** `M … L …` with small rounded corners, so routed polylines stop looking jagged. */
export function polylinePath(points: Point[], radius = 7): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${round(points[0].x)} ${round(points[0].y)} L${round(points[1].x)} ${round(points[1].y)}`;
  }
  let d = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(current.x - prev.x, current.y - prev.y);
    const outLen = Math.hypot(next.x - current.x, next.y - current.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L${round(current.x)} ${round(current.y)}`;
      continue;
    }
    const a = { x: current.x + ((prev.x - current.x) / inLen) * r, y: current.y + ((prev.y - current.y) / inLen) * r };
    const b = { x: current.x + ((next.x - current.x) / outLen) * r, y: current.y + ((next.y - current.y) / outLen) * r };
    d += ` L${round(a.x)} ${round(a.y)} Q${round(current.x)} ${round(current.y)} ${round(b.x)} ${round(b.y)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${round(last.x)} ${round(last.y)}`;
}

/** Horizontal S-curve, the shape a mind map branch is expected to have. */
function curvePath(p1: Point, p2: Point, horizontal: boolean): string {
  if (horizontal) {
    const bend = Math.max(26, Math.abs(p2.x - p1.x) * 0.48) * (p1.x <= p2.x ? 1 : -1);
    return (
      `M${round(p1.x)} ${round(p1.y)} ` +
      `C${round(p1.x + bend)} ${round(p1.y)} ${round(p2.x - bend)} ${round(p2.y)} ${round(p2.x)} ${round(p2.y)}`
    );
  }
  const bend = Math.max(20, Math.abs(p2.y - p1.y) * 0.48) * (p1.y <= p2.y ? 1 : -1);
  return (
    `M${round(p1.x)} ${round(p1.y)} ` +
    `C${round(p1.x)} ${round(p1.y + bend)} ${round(p2.x)} ${round(p2.y - bend)} ${round(p2.x)} ${round(p2.y)}`
  );
}

/** Longest usable segment of a routed polyline, as a label anchor. */
function midpointOf(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return {
    x: (points[best].x + points[best + 1].x) / 2,
    y: (points[best].y + points[best + 1].y) / 2,
  };
}

/** `null` when either endpoint vanished (a stale edge after a delete). */
export function edgeGeometry(model: DiagramModel, edge: DiagramEdge): EdgeGeometry | null {
  const a = nodeById(model, edge.from);
  const b = nodeById(model, edge.to);
  if (!a || !b) return null;
  const { p1, p2, horizontal } = anchorPair(model, a, b);

  if (model.mode === "mindmap") {
    const d = curvePath(p1, p2, horizontal);
    const at = p1.x <= p2.x ? { x: p1.x + (p2.x - p1.x) * 0.55, y: (p1.y + p2.y) / 2 } : { x: p2.x + (p1.x - p2.x) * 0.45, y: (p1.y + p2.y) / 2 };
    return { d, labelAt: at, horizontal };
  }

  const route = edge.route;
  const points = route && route.length >= 2 ? [p1, ...route.slice(1, -1), p2] : elbowRoute(p1, p2, horizontal);
  return { d: polylinePath(points), labelAt: midpointOf(points), horizontal };
}
