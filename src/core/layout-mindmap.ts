import { childrenOf, rootNodes, type DiagramModel, type DiagramNode, type MindmapLayout } from "./model";
import { measureNode } from "./measure";

/**
 * Tidy tree layout for mind maps.
 *
 * Leaves are stacked in write order, each parent is centred on its children, and
 * column positions come from the widest node on each level — so a level with long
 * labels pushes the next level out instead of overlapping it.
 *
 * Levels are derived here rather than read from the parser, because nodes added
 * on the canvas never went through a parse. Pinned nodes keep the coordinates the
 * user dragged them to.
 */

const COLUMN_GAP = 48;
const ROW_GAP = 16;
const RECURSION_GUARD = 10000;

function ownSpan(node: DiagramNode): number {
  return measureNode(node).h + ROW_GAP;
}

/** Breadth-first level assignment from the roots, with a cycle guard. */
function assignLevels(model: DiagramModel): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: Array<{ node: DiagramNode; level: number }> = rootNodes(model).map((node) => ({
    node,
    level: 0,
  }));
  let guard = 0;
  while (queue.length && guard++ < RECURSION_GUARD) {
    const item = queue.shift();
    if (!item) break;
    if (levels.has(item.node.id)) continue;
    levels.set(item.node.id, item.level);
    for (const child of childrenOf(model, item.node.id)) {
      if (!levels.has(child.id)) queue.push({ node: child, level: item.level + 1 });
    }
  }
  for (const node of model.nodes) if (!levels.has(node.id)) levels.set(node.id, 0);
  return levels;
}

/**
 * Vertical budget per node: its own row, or the sum of its children's when they
 * need more room. Memoised, with a re-entry guard so a malformed model (a cycle
 * introduced by connecting a node to its own descendant) cannot hang the editor.
 */
function assignSpans(model: DiagramModel): Map<string, number> {
  const spans = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (node: DiagramNode): number => {
    const cached = spans.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) return ownSpan(node);
    visiting.add(node.id);

    const own = ownSpan(node);
    const kids = childrenOf(model, node.id);
    let total = 0;
    for (const child of kids) total += visit(child);

    const span = kids.length ? Math.max(own, total) : own;
    spans.set(node.id, span);
    visiting.delete(node.id);
    return span;
  };

  for (const node of model.nodes) visit(node);
  return spans;
}

function placeSubtree(
  model: DiagramModel,
  node: DiagramNode,
  top: number,
  context: LayoutContext,
  side: 1 | -1
): void {
  const span = context.spans.get(node.id) ?? ownSpan(node);
  if (!node.pinned) {
    node.x = side * context.columnX(context.levels.get(node.id) ?? 0);
    node.y = top + span / 2;
  }

  const kids = childrenOf(model, node.id);
  if (!kids.length) return;

  let used = 0;
  for (const child of kids) used += context.spans.get(child.id) ?? 0;
  // When a parent's own row is taller than its whole subtree, centre the
  // children inside the parent's band instead of letting them hug its top edge.
  let cursor = top + Math.max(0, (span - used) / 2);
  for (const child of kids) {
    placeSubtree(model, child, cursor, context, side);
    cursor += context.spans.get(child.id) ?? 0;
  }
}

function placeSiblings(
  model: DiagramModel,
  siblings: DiagramNode[],
  top: number,
  context: LayoutContext,
  side: 1 | -1
): void {
  let cursor = top;
  for (const node of siblings) {
    placeSubtree(model, node, cursor, context, side);
    cursor += context.spans.get(node.id) ?? ownSpan(node);
  }
}

interface LayoutContext {
  levels: Map<string, number>;
  spans: Map<string, number>;
  columnX: (level: number) => number;
}

function centreVertically(model: DiagramModel): void {
  if (!model.nodes.length) return;
  let min = Infinity;
  let max = -Infinity;
  for (const node of model.nodes) {
    const size = measureNode(node);
    min = Math.min(min, node.y - size.h / 2);
    max = Math.max(max, node.y + size.h / 2);
  }
  const mid = (min + max) / 2;
  for (const node of model.nodes) node.y -= mid;
}

export function layoutMindmap(model: DiagramModel, layout: MindmapLayout = "right"): void {
  if (!model.nodes.length) return;

  const levels = assignLevels(model);
  const spans = assignSpans(model);

  const widest = new Map<number, number>();
  for (const node of model.nodes) {
    const level = levels.get(node.id) ?? 0;
    widest.set(level, Math.max(widest.get(level) ?? 0, measureNode(node).w));
  }
  const centres = new Map<number, number>([[0, 0]]);
  const maxLevel = Math.max(0, ...levels.values());
  for (let level = 1; level <= maxLevel; level++) {
    const previous = centres.get(level - 1) ?? 0;
    centres.set(
      level,
      previous + (widest.get(level - 1) ?? 0) / 2 + COLUMN_GAP + (widest.get(level) ?? 0) / 2
    );
  }

  const context: LayoutContext = {
    levels,
    spans,
    columnX: (level: number) => centres.get(level) ?? 0,
  };

  let cursor = 0;
  for (const root of rootNodes(model)) {
    const span = spans.get(root.id) ?? ownSpan(root);
    const children = childrenOf(model, root.id);
    const half = Math.ceil(children.length / 2);
    const right = layout === "left" ? [] : layout === "both" ? children.slice(0, half) : children;
    const left = layout === "left" ? children : layout === "both" ? children.slice(half) : [];

    if (!root.pinned) {
      root.x = 0;
      root.y = cursor + span / 2;
    }
    // Both halves share one vertical band, which is what makes a two-sided map
    // read as a single balanced shape rather than two trees glued together.
    placeSiblings(model, right, cursor, context, 1);
    placeSiblings(model, left, cursor, context, -1);
    cursor += span;
  }

  centreVertically(model);
}
