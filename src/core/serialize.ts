import { LAYOUT_ANNOTATION, type DiagramModel, type DiagramNode } from "./model";
import { pinnedPositions } from "./parse";

export interface SerializeOptions {
  /**
   * Write the coordinate annotation for pinned nodes. Turning this off means
   * dragged positions are not persisted, which is the documented fallback for
   * renderers that choke on the comment line.
   */
  persistPositions?: boolean;
}

const SHAPE_OPENERS: Record<string, [string, string]> = {
  rect: ["[", "]"],
  stadium: ["([", "])"],
  circle: ["((", "))"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
};

const MINDMAP_SHAPE_OPENERS: Record<string, [string, string]> = {
  rect: ["[", "]"],
  stadium: ["(", ")"],
  circle: ["((", "))"],
  diamond: ["{{", "}}"],
  hexagon: ["{{", "}}"],
};

/** Quotes a label only when mermaid would otherwise misread the delimiters. */
function escapeBody(text: string): string {
  const value = String(text);
  if (!/[[](){}"|]/.test(value)) return value;
  return `"${value.replace(/"/g, "#quot;")}"`;
}

function shapeBody(model: DiagramModel, node: DiagramNode): string {
  const text = escapeBody(node.text);
  if (model.mode === "mindmap") {
    const [open, close] = MINDMAP_SHAPE_OPENERS[node.shape] ?? MINDMAP_SHAPE_OPENERS.rect;
    return `${node.alias || ""}${open}${text}${close}`;
  }
  const [open, close] = SHAPE_OPENERS[node.shape] ?? SHAPE_OPENERS.rect;
  return `${open}${text}${close}`;
}

function childrenMap(model: DiagramModel): Map<string, DiagramNode[]> {
  const map = new Map<string, DiagramNode[]>();
  for (const edge of model.edges) {
    const child = model.nodes.find((n) => n.id === edge.to);
    if (!child) continue;
    const list = map.get(edge.from);
    if (list) list.push(child);
    else map.set(edge.from, [child]);
  }
  return map;
}

/**
 * Model back to mermaid text.
 *
 * Order matters and is deliberate: graph body first, then the coordinate
 * annotation, then every line we did not model. mermaid itself requires
 * `classDef` / `class` / `style` to follow the graph, so echoing them last keeps
 * a file that mermaid can still render on its own.
 */
export function serializeDiagram(model: DiagramModel, options: SerializeOptions = {}): string {
  const out: string[] = [];
  const kids = childrenMap(model);

  if (model.mode === "mindmap") {
    out.push("mindmap");
    const targeted = new Set(model.edges.map((e) => e.to));
    const roots = model.nodes.filter((n) => !targeted.has(n.id));
    const walk = (node: DiagramNode, depth: number): void => {
      out.push(`${"  ".repeat(depth + 1)}${shapeBody(model, node)}`);
      for (const child of kids.get(node.id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots.length ? roots : model.nodes.slice(0, 1)) walk(root, 0);
  } else {
    out.push(`flowchart ${model.direction || "TD"}`);
    for (const node of model.nodes) out.push(`  ${node.id}${shapeBody(model, node)}`);
    for (const edge of model.edges) {
      const label = edge.label ? `|${escapeBody(edge.label)}|` : "";
      out.push(`  ${edge.from} -->${label} ${edge.to}`);
    }
  }

  if (options.persistPositions !== false) {
    const pinned = pinnedPositions(model);
    const keys = Object.keys(pinned);
    if (keys.length) {
      out.push(
        `%% ${LAYOUT_ANNOTATION} ${keys
          .map((key) => `${key}=${pinned[key].x},${pinned[key].y}`)
          .join(" ")}`
      );
    }
  }

  for (const line of model.passthrough) out.push(line);
  return `${out.join("\n")}\n`;
}
