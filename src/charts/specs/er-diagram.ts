import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { boxAt, caption, el, group, halo, line, nextId, setAttrs, text, textWidth } from "../draw";
import { elbowPath, layoutGraph, polylinePath, routeMidpoint } from "../graph-layout";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Entity-relationship diagrams.
 *
 * Cardinality is stored as a *meaning* (`zero-many`) rather than as the two
 * characters mermaid writes, because those characters are positional: the same
 * "zero or more" is `}o` on the left of the line and `o{` on the right. Storing
 * the glyphs would mean re-deriving the meaning on every save, and getting it
 * backwards silently turns "one customer has many orders" into "many customers
 * belong to one order".
 */

type Cardinality = "one" | "zero-one" | "one-many" | "zero-many";

interface EntityItem {
  id: string;
  name: string;
  fields: string[];
  x: number;
  y: number;
  pinned?: boolean;
}

interface EntityEdge {
  id: string;
  from: string;
  to: string;
  /** Cardinality at the `from` end. */
  left: Cardinality;
  /** Cardinality at the `to` end. */
  right: Cardinality;
  /** Solid for an identifying relationship, dashed otherwise. */
  identifying: boolean;
  label: string;
}

interface ErChart {
  items: EntityItem[];
  edges: EntityEdge[];
  passthrough: string[];
  linking: string | null;
  routes: Map<string, Point[]>;
}

const HEADER_RE = /^erDiagram\b/i;
const FIELD_BLOCK_RE = /^([A-Za-z0-9_-]+)\s*\{$/;
const REL_RE =
  /^([A-Za-z0-9_-]+)\s+(\|\||\|o|\}o|\}\||o\||o\{|\|\{)(--|\.\.)(\|\||\|o|\}o|\}\||o\||o\{|\|\{)\s+([A-Za-z0-9_-]+)\s*(?::\s*(.*))?$/;
const COLON_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/;

const LINE_H = 18;
const HDR_H = 26;
const PAD_X = 12;

/** Glyphs as written when the entity sits on the left of the line. */
const LEFT_GLYPH: Record<Cardinality, string> = {
  one: "||",
  "zero-one": "|o",
  "one-many": "}|",
  "zero-many": "}o",
};

/** …and on the right. */
const RIGHT_GLYPH: Record<Cardinality, string> = {
  one: "||",
  "zero-one": "o|",
  "one-many": "|{",
  "zero-many": "o{",
};

function readCardinality(glyph: string, side: "left" | "right"): Cardinality {
  const table = side === "left" ? LEFT_GLYPH : RIGHT_GLYPH;
  for (const key of Object.keys(table) as Cardinality[]) {
    if (table[key] === glyph) return key;
  }
  return side === "left" ? "one" : "zero-many";
}

function sizeOf(item: EntityItem): { w: number; h: number } {
  const widest = item.fields.reduce((max, field) => Math.max(max, textWidth(field, 11.5)), 0);
  return {
    w: Math.max(118, textWidth(item.name, 13) + PAD_X * 2, widest + PAD_X * 2),
    h: HDR_H + Math.max(1, item.fields.length) * LINE_H,
  };
}

function create(): ErChart {
  return { items: [], edges: [], passthrough: [], linking: null, routes: new Map() };
}

function parse(source: string): ErChart {
  const chart = create();
  const byName = new Map<string, EntityItem>();

  const ensure = (raw: string): EntityItem => {
    const value = raw.trim();
    const found = byName.get(value);
    if (found) return found;
    const item: EntityItem = { id: nextId(chart.items.map((i) => i.id), "t"), name: value, fields: [], x: 0, y: 0 };
    chart.items.push(item);
    byName.set(value, item);
    return item;
  };

  let block: string | null = null;
  let seenHeader = false;

  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;

    if (block) {
      if (current === "}") {
        block = null;
        continue;
      }
      const item = ensure(block);
      if (item.fields.length < 24) item.fields.push(current);
      continue;
    }
    if (!seenHeader && HEADER_RE.test(current)) {
      seenHeader = true;
      continue;
    }
    if (current.startsWith("%%")) {
      chart.passthrough.push(current);
      continue;
    }
    const open = FIELD_BLOCK_RE.exec(current);
    if (open) {
      ensure(open[1]);
      block = open[1];
      continue;
    }
    const rel = REL_RE.exec(current);
    if (rel) {
      const from = ensure(rel[1]);
      const to = ensure(rel[5]);
      chart.edges.push({
        id: nextId(chart.edges.map((e) => e.id), "r"),
        from: from.id,
        to: to.id,
        left: readCardinality(rel[2], "left"),
        right: readCardinality(rel[4], "right"),
        identifying: rel[3] === "--",
        label: (rel[6] ?? "").trim(),
      });
      continue;
    }
    const colon = COLON_RE.exec(current);
    if (colon) {
      const item = ensure(colon[1]);
      if (item.fields.length < 24) item.fields.push(colon[2].trim());
      continue;
    }
    chart.passthrough.push(current);
  }

  return chart;
}

function itemById(chart: ErChart, id: string): EntityItem | null {
  return chart.items.find((i) => i.id === id) ?? null;
}

function serialize(chart: ErChart): string {
  const out = ["erDiagram"];
  const referenced = new Set<string>();

  for (const edge of chart.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
    const link = edge.identifying ? "--" : "..";
    const name = (id: string): string => itemById(chart, id)?.name ?? "?";
    const suffix = edge.label ? ` : ${edge.label}` : "";
    out.push(
      `  ${name(edge.from)} ${LEFT_GLYPH[edge.left]}${link}${RIGHT_GLYPH[edge.right]} ${name(edge.to)}${suffix}`
    );
  }

  for (const item of chart.items) {
    if (!item.fields.length && referenced.has(item.id)) continue;
    out.push(`  ${item.name} {`);
    for (const field of item.fields) out.push(`    ${field}`);
    out.push("  }");
  }

  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function layout(chart: ErChart): void {
  const nodes = chart.items.map((item) => {
    const size = sizeOf(item);
    return { id: item.id, w: size.w, h: size.h, pinned: item.pinned };
  });
  const edges = chart.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }));
  // Left-to-right: entity boxes are wide and short, so stacking them vertically
  // wastes more space than it saves.
  const result = layoutGraph(nodes, edges, { direction: "LR", nodeSep: 44, rankSep: 96 });
  for (const item of chart.items) {
    const point = result.positions.get(item.id);
    if (!point || item.pinned) continue;
    item.x = point.x;
    item.y = point.y;
  }
  chart.routes = result.routes;
}

function boundary(item: EntityItem, toward: Point): Point {
  const size = sizeOf(item);
  const dx = toward.x - item.x;
  const dy = toward.y - item.y;
  if (!dx && !dy) return { x: item.x, y: item.y };
  const scale = Math.min(
    size.w / 2 / Math.max(Math.abs(dx), 1e-6),
    size.h / 2 / Math.max(Math.abs(dy), 1e-6)
  );
  return { x: item.x + dx * scale, y: item.y + dy * scale };
}

function edgePath(chart: ErChart, edge: EntityEdge): { d: string; from: Point; to: Point } | null {
  const a = itemById(chart, edge.from);
  const b = itemById(chart, edge.to);
  if (!a || !b) return null;
  const from = boundary(a, b);
  const to = boundary(b, a);
  const route = chart.routes.get(edge.id);
  if (!route || route.length < 2) return { d: elbowPath(from, to, "LR"), from, to };
  return { d: polylinePath([from, ...route.slice(1, -1), to]), from, to };
}

/**
 * Crow's-foot notation, drawn from the entity outwards.
 *
 * `origin` is the point where the line meets the box, `angle` the direction the
 * line leaves in. "One" is a pair of perpendicular ticks, "many" a three-prong
 * fork, and "zero" an open circle on the outside — which is exactly how mermaid
 * draws it, so the editor and the renderer agree on what the diagram says.
 */
function crow(parent: Element, origin: Point, angle: number, card: Cardinality, color: string): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (forward: number, side = 0): Point => ({
    x: origin.x + cos * forward - sin * side,
    y: origin.y + sin * forward + cos * side,
  });
  const tick = (forward: number, half: number): void => {
    const a = at(forward, -half);
    const b = at(forward, half);
    line(parent, a.x, a.y, b.x, b.y, { stroke: color, sw: 1.3 });
  };
  const fork = (forward: number): void => {
    const base = at(forward + 12);
    for (const side of [-7, 0, 7]) {
      const tip = at(forward, side);
      line(parent, base.x, base.y, tip.x, tip.y, { stroke: color, sw: 1.3 });
    }
  };

  switch (card) {
    case "one":
      tick(2, 6);
      tick(10, 6);
      break;
    case "zero-one":
      circle(parent, at(4), 3.6, color);
      tick(14, 6);
      break;
    case "one-many":
      tick(14, 6);
      fork(2);
      break;
    case "zero-many":
      circle(parent, at(4), 3.6, color);
      fork(13);
      break;
  }
}

function circle(parent: Element, centre: Point, r: number, color: string): void {
  const node = el("circle");
  setAttrs(node, { cx: centre.x, cy: centre.y, r, fill: "none", stroke: color, "stroke-width": 1.3 });
  parent.appendChild(node);
}

function extend(chart: ErChart): Bounds | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const item of chart.items) {
    const size = sizeOf(item);
    x1 = Math.min(x1, item.x - size.w / 2);
    y1 = Math.min(y1, item.y - size.h / 2);
    x2 = Math.max(x2, item.x + size.w / 2);
    y2 = Math.max(y2, item.y + size.h / 2);
  }
  if (!Number.isFinite(x1)) return null;
  return { x1, y1, x2, y2 };
}

function render(ctx: ChartRenderContext<ErChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const edgeLayer = group(layer, "mtk-chart-edges");
  const nodeLayer = group(layer, "mtk-chart-nodes");

  for (const edge of state.edges) {
    const geometry = edgePath(state, edge);
    if (!geometry) continue;
    const angle = Math.atan2(geometry.to.y - geometry.from.y, geometry.to.x - geometry.from.x);
    line(edgeLayer, geometry.from.x, geometry.from.y, geometry.to.x, geometry.to.y, {
      stroke: palette.edge,
      dash: edge.identifying ? undefined : "5 4",
    });
    crow(edgeLayer, geometry.from, angle, edge.left, palette.edge);
    crow(edgeLayer, geometry.to, angle + Math.PI, edge.right, palette.edge);
    line(edgeLayer, geometry.from.x, geometry.from.y, geometry.to.x, geometry.to.y, {
      stroke: "transparent",
      sw: 12,
      id: edge.id,
    });
    if (edge.label) {
      const mid = routeMidpoint(state.routes.get(edge.id), geometry.from, geometry.to);
      text(edgeLayer, edge.label, mid.x, mid.y - 9, {
        size: 11,
        color: palette.edgeText,
        halo: palette.surface,
        maxLines: 1,
      });
    }
    if (selected === edge.id) {
      const mid = routeMidpoint(state.routes.get(edge.id), geometry.from, geometry.to);
      halo(edgeLayer, mid.x - 34, mid.y + 2, 68, 18, palette.accent, 6);
    }
  }

  for (const item of state.items) {
    const size = sizeOf(item);
    const g = group(nodeLayer, "mtk-chart-node");
    const left = item.x - size.w / 2;
    const top = item.y - size.h / 2;

    if (selected === item.id) halo(g, left, top, size.w, size.h, palette.accent, 9);
    const linking = state.linking === item.id;
    boxAt(g, item.x, item.y, size.w, size.h, {
      rx: 6,
      fill: linking ? palette.rootFill : palette.fill,
      stroke: linking ? palette.accent : palette.stroke,
      sw: linking ? 1.5 : 1,
      id: item.id,
    });
    text(g, item.name, item.x, top + HDR_H / 2, {
      size: 13,
      color: palette.rootText,
      weight: 600,
      maxUnits: 18,
      maxLines: 1,
      id: item.id,
    });
    line(g, left, top + HDR_H, left + size.w, top + HDR_H, { stroke: palette.stroke, sw: 1 });

    item.fields.forEach((field, index) => {
      caption(g, field, left + PAD_X, top + HDR_H + LINE_H / 2 + index * LINE_H, {
        size: 11.5,
        color: palette.text,
        id: item.id,
      });
    });

    if (!interactive) continue;
    grip({
      id: item.id,
      x: item.x,
      y: item.y,
      r: Math.max(size.w, size.h) / 2 + 4,
      axis: "xy",
      cursor: "move",
      begin: () => ({ x: item.x, y: item.y }),
      drag: (dx, dy, start) => {
        const from = start as Point;
        item.x = from.x + dx;
        item.y = from.y + dy;
        item.pinned = true;
      },
    });
  }
}

const CARD_OPTIONS: Array<{ value: Cardinality; key: string }> = [
  { value: "one", key: "chart.er.one" },
  { value: "zero-one", key: "chart.er.zeroOne" },
  { value: "one-many", key: "chart.er.oneMany" },
  { value: "zero-many", key: "chart.er.zeroMany" },
];

function panel(state: ErChart, selected: string | null): ChartField[] {
  if (state.linking) {
    const source = itemById(state, state.linking);
    return [
      { kind: "note", text: t("chart.er.pickTarget", { name: source?.name ?? "" }) },
      {
        kind: "button",
        label: t("chart.cancel"),
        icon: "x",
        apply: () => {
          state.linking = null;
        },
      },
    ];
  }

  const edge = state.edges.find((e) => e.id === selected);
  if (edge) {
    const from = itemById(state, edge.from);
    const to = itemById(state, edge.to);
    const options = CARD_OPTIONS.map((entry) => ({ value: entry.value, label: t(entry.key) }));
    return [
      { kind: "note", text: `${from?.name ?? "?"} → ${to?.name ?? "?"}` },
      {
        kind: "select",
        label: `${from?.name ?? "?"} ${t("chart.er.side")}`,
        value: edge.left,
        options,
        apply: (value) => {
          if (value) edge.left = value as Cardinality;
        },
      },
      {
        kind: "select",
        label: `${to?.name ?? "?"} ${t("chart.er.side")}`,
        value: edge.right,
        options,
        apply: (value) => {
          if (value) edge.right = value as Cardinality;
        },
      },
      {
        kind: "select",
        label: t("chart.er.kind"),
        value: edge.identifying ? "solid" : "dashed",
        options: [
          { value: "solid", label: t("chart.er.identifying") },
          { value: "dashed", label: t("chart.er.nonIdentifying") },
        ],
        apply: (value) => {
          edge.identifying = value === "solid";
        },
      },
      {
        kind: "text",
        label: t("chart.er.label"),
        value: edge.label,
        apply: (value) => {
          edge.label = value;
        },
      },
      { kind: "button", label: t("chart.deleteRelation"), icon: "trash-2", apply: () => remove(state, edge.id) },
    ];
  }

  const item = selected ? itemById(state, selected) : null;
  if (item) {
    const fields: ChartField[] = [
      {
        kind: "text",
        label: t("chart.er.name"),
        value: item.name,
        apply: (value) => {
          const next = value.trim();
          if (next) item.name = next;
        },
      },
      {
        kind: "rows",
        label: t("chart.er.fields"),
        value: item.fields,
        placeholder: t("chart.er.fieldPlaceholder"),
        apply: (value) => {
          item.fields = value.filter((entry) => entry.trim().length > 0);
        },
      },
      {
        kind: "button",
        label: t("chart.er.addRelation"),
        icon: "corner-down-right",
        apply: () => {
          state.linking = item.id;
        },
      },
    ];
    if (item.pinned) {
      fields.push({
        kind: "button",
        label: t("chart.release"),
        icon: "move",
        apply: () => {
          item.pinned = false;
        },
      });
    }
    fields.push({ kind: "button", label: t("chart.deleteEntity"), icon: "trash-2", apply: () => remove(state, item.id) });
    return fields;
  }

  return [
    { kind: "note", text: t("chart.er.empty") },
    { kind: "button", label: t("chart.er.addEntity"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: ErChart): string {
  const taken = state.items.map((i) => i.name);
  let index = state.items.length + 1;
  while (taken.includes(`ENTITY_${index}`)) index += 1;
  const id = nextId(state.items.map((i) => i.id), "t");
  const bounds = extend(state);
  state.items.push({
    id,
    name: `ENTITY_${index}`,
    fields: ["string name"],
    x: bounds ? bounds.x2 + 180 : 0,
    y: bounds ? (bounds.y1 + bounds.y2) / 2 : 0,
  });
  return id;
}

function remove(state: ErChart, id: string): void {
  if (state.edges.some((e) => e.id === id)) {
    state.edges = state.edges.filter((e) => e.id !== id);
    return;
  }
  if (!state.items.some((i) => i.id === id)) return;
  state.items = state.items.filter((i) => i.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.linking === id) state.linking = null;
}

export const erSpec: ChartSpec<ErChart> = {
  id: "er",
  blank: () =>
    parse(
      [
        "erDiagram",
        "  CUSTOMER ||--o{ ORDER : places",
        "  ORDER ||--|{ ORDER_ITEM : contains",
        "  CUSTOMER {",
        "    string name",
        "  }",
      ].join("\n")
    ),
  parse,
  layout,
  render,
  serialize,
  panel,
  add,
  remove,
  extent: extend,
  summary: (state) => ({ nodes: state.items.length, edges: state.edges.length }),
  onClick: (state) => {
    if (!state.linking) return null;
    state.linking = null;
    return null;
  },
  onPick: (state, id) => {
    if (!state.linking) return false;
    const target = itemById(state, id);
    if (!target || target.id === state.linking) return false;
    state.edges.push({
      id: nextId(state.edges.map((e) => e.id), "r"),
      from: state.linking,
      to: target.id,
      left: "one",
      right: "zero-many",
      identifying: true,
      label: "",
    });
    state.linking = null;
    return true;
  },
  hints: () => ["chart.hint.drag", "chart.hint.er"],
};
