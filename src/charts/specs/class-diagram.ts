import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { boxAt, caption, group, halo, line, nextId, text, textWidth } from "../draw";
import { elbowPath, layoutGraph, polylinePath, routeMidpoint } from "../graph-layout";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";
import type { MarkerName } from "../draw";

/**
 * Class diagrams.
 *
 * The load-bearing detail is which *end* each relation decorates. mermaid
 * writes `A <|-- B` for "B inherits A", so the hollow triangle belongs at the
 * `A` end — the `from` end — not at the target. Reading it as "arrow at `to`"
 * would draw every inheritance backwards while still looking plausible, which
 * is exactly the kind of bug a screenshot will not catch. So each operator
 * carries its own decoration, and the operator is preserved verbatim on save.
 */

interface ClassItem {
  id: string;
  name: string;
  attrs: string[];
  methods: string[];
  x: number;
  y: number;
  pinned?: boolean;
}

interface ClassEdge {
  id: string;
  from: string;
  to: string;
  /** The operator exactly as written, so a save never rewrites the user's syntax. */
  op: string;
  label: string;
}

interface ClassChart {
  items: ClassItem[];
  edges: ClassEdge[];
  passthrough: string[];
  linking: string | null;
  routes: Map<string, Point[]>;
}

const HEADER_RE = /^classDiagram\b/i;
const OPERATORS = [
  "<\\|--",
  "--\\|>",
  "<\\|\\.\\.",
  "\\.\\.\\|>",
  "\\*--",
  "--\\*",
  "o--",
  "--o",
  "<--",
  "-->",
  "\\.\\.>",
  "<\\.\\.",
  "--",
  "\\.\\.",
];
const REL_RE = new RegExp(
  `^([A-Za-z0-9_-]+)\\s*(${OPERATORS.join("|")})\\s*([A-Za-z0-9_-]+)\\s*(?::\\s*(.*))?$`
);
const MEMBER_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/;
const OPEN_RE = /^class\s+([A-Za-z0-9_-]+)\s*\{$/;
const BARE_RE = /^class\s+([A-Za-z0-9_-]+)$/;

const LINE_H = 18;
const HDR_H = 28;
const PAD_X = 13;
const DEFAULT_OP = "-->";

const RELATION_LABELS: Record<string, string> = {
  "<|--": "chart.rel.inheritance",
  "--|>": "chart.rel.inheritance",
  "<|..": "chart.rel.realization",
  "..|>": "chart.rel.realization",
  "*--": "chart.rel.composition",
  "--*": "chart.rel.composition",
  "o--": "chart.rel.aggregation",
  "--o": "chart.rel.aggregation",
  "-->": "chart.rel.association",
  "<--": "chart.rel.association",
  "..>": "chart.rel.dependency",
  "<..": "chart.rel.dependency",
  "--": "chart.rel.link",
  "..": "chart.rel.link",
};

const RELATION_GROUPS: Array<{ op: string; labelKey: string }> = [
  { op: "<|--", labelKey: "chart.rel.inheritance" },
  { op: "*--", labelKey: "chart.rel.composition" },
  { op: "o--", labelKey: "chart.rel.aggregation" },
  { op: "-->", labelKey: "chart.rel.association" },
  { op: "..>", labelKey: "chart.rel.dependency" },
  { op: "..|>", labelKey: "chart.rel.realization" },
  { op: "--", labelKey: "chart.rel.link" },
];

function decoration(op: string): { dash?: string; start?: MarkerName; end?: MarkerName } {
  switch (op) {
    case "<|--":
      return { start: "triangle" };
    case "--|>":
      return { end: "triangle" };
    case "<|..":
      return { dash: "5 4", start: "triangle" };
    case "..|>":
      return { dash: "5 4", end: "triangle" };
    case "*--":
      return { start: "diamondFilled" };
    case "--*":
      return { end: "diamondFilled" };
    case "o--":
      return { start: "diamond" };
    case "--o":
      return { end: "diamond" };
    case "-->":
      return { end: "arrow" };
    case "<--":
      return { start: "arrow" };
    case "..>":
      return { dash: "5 4", end: "arrow" };
    case "<..":
      return { dash: "5 4", start: "arrow" };
    default:
      return {};
  }
}

function sizeOf(item: ClassItem): { w: number; h: number } {
  const widest = (list: string[]): number =>
    list.reduce((max, entry) => Math.max(max, textWidth(entry, 11.5)), 0);
  const w = Math.max(
    124,
    textWidth(item.name, 13.5) + PAD_X * 2,
    widest(item.attrs) + PAD_X * 2,
    widest(item.methods) + PAD_X * 2
  );
  const rows = item.attrs.length + item.methods.length;
  return { w, h: HDR_H + Math.max(1, rows) * LINE_H };
}

function create(): ClassChart {
  return { items: [], edges: [], passthrough: [], linking: null, routes: new Map() };
}

function parse(source: string): ClassChart {
  const chart = create();
  const byName = new Map<string, ClassItem>();

  const ensure = (raw: string): ClassItem => {
    const value = raw.trim();
    const found = byName.get(value);
    if (found) return found;
    const item: ClassItem = { id: nextId(chart.items.map((i) => i.id), "c"), name: value, attrs: [], methods: [], x: 0, y: 0 };
    chart.items.push(item);
    byName.set(value, item);
    return item;
  };

  const addMember = (owner: string, raw: string): void => {
    const member = raw.trim();
    if (!member) return;
    const item = ensure(owner);
    // mermaid has no separate syntax for the two sections; a call signature is
    // what makes something a method.
    if (member.includes("(")) item.methods.push(member);
    else item.attrs.push(member);
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
      addMember(block, current);
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
    const open = OPEN_RE.exec(current);
    if (open) {
      ensure(open[1]);
      block = open[1];
      continue;
    }
    const bare = BARE_RE.exec(current);
    if (bare) {
      ensure(bare[1]);
      continue;
    }
    const rel = REL_RE.exec(current);
    if (rel) {
      const from = ensure(rel[1]);
      const to = ensure(rel[3]);
      chart.edges.push({
        id: nextId(chart.edges.map((e) => e.id), "r"),
        from: from.id,
        to: to.id,
        op: rel[2],
        label: (rel[4] ?? "").trim(),
      });
      continue;
    }
    const member = MEMBER_RE.exec(current);
    if (member) {
      addMember(member[1], member[2]);
      continue;
    }
    chart.passthrough.push(current);
  }

  return chart;
}

function itemById(chart: ClassChart, id: string): ClassItem | null {
  return chart.items.find((i) => i.id === id) ?? null;
}

function serialize(chart: ClassChart): string {
  const out = ["classDiagram"];
  const referenced = new Set<string>();
  for (const edge of chart.edges) {
    referenced.add(edge.from);
    referenced.add(edge.to);
    const suffix = edge.label ? ` : ${edge.label}` : "";
    out.push(`  ${itemById(chart, edge.from)?.name ?? "?"} ${edge.op} ${itemById(chart, edge.to)?.name ?? "?"}${suffix}`);
  }

  // Every class is written as a block, whether or not it has members: a class
  // with no relation to anything would otherwise vanish on the next save.
  for (const item of chart.items) {
    if (item.attrs.length || item.methods.length) {
      out.push(`  class ${item.name} {`);
      for (const attr of item.attrs) out.push(`    ${attr}`);
      for (const method of item.methods) out.push(`    ${method}`);
      out.push("  }");
    } else if (!referenced.has(item.id)) {
      out.push(`  class ${item.name}`);
    }
  }

  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function layout(chart: ClassChart): void {
  const nodes = chart.items.map((item) => {
    const size = sizeOf(item);
    return { id: item.id, w: size.w, h: size.h, pinned: item.pinned };
  });
  const edges = chart.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }));
  const result = layoutGraph(nodes, edges, { direction: "TD", nodeSep: 48, rankSep: 74 });
  for (const item of chart.items) {
    const point = result.positions.get(item.id);
    if (!point || item.pinned) continue;
    item.x = point.x;
    item.y = point.y;
  }
  chart.routes = result.routes;
}

function boundary(item: ClassItem, toward: Point): Point {
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

function edgePath(chart: ClassChart, edge: ClassEdge): { d: string; from: Point; to: Point } | null {
  const a = itemById(chart, edge.from);
  const b = itemById(chart, edge.to);
  if (!a || !b) return null;
  const from = boundary(a, b);
  const to = boundary(b, a);
  const route = chart.routes.get(edge.id);
  if (!route || route.length < 2) return { d: elbowPath(from, to, "TD"), from, to };
  return { d: polylinePath([from, ...route.slice(1, -1), to]), from, to };
}

function extend(chart: ClassChart): Bounds | null {
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

function render(ctx: ChartRenderContext<ClassChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const edgeLayer = group(layer, "mtk-chart-edges");
  const nodeLayer = group(layer, "mtk-chart-nodes");

  for (const edge of state.edges) {
    const geometry = edgePath(state, edge);
    if (!geometry) continue;
    const decor = decoration(edge.op);
    line(edgeLayer, geometry.from.x, geometry.from.y, geometry.to.x, geometry.to.y, {
      stroke: palette.edge,
      dash: decor.dash,
      markerStart: decor.start,
      markerEnd: decor.end,
    });
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
      text(edgeLayer, RELATION_LABELS[edge.op] ? t(RELATION_LABELS[edge.op]) : edge.op, mid.x, mid.y + 12, {
        size: 10.5,
        color: palette.accent,
        halo: palette.surface,
        maxLines: 1,
      });
    }
  }

  for (const item of state.items) {
    const size = sizeOf(item);
    const g = group(nodeLayer, "mtk-chart-node");
    const left = item.x - size.w / 2;
    const top = item.y - size.h / 2;

    if (selected === item.id) halo(g, left, top, size.w, size.h, palette.accent, 10);

    const linking = state.linking === item.id;
    boxAt(g, item.x, item.y, size.w, size.h, {
      rx: 7,
      fill: linking ? palette.rootFill : palette.fill,
      stroke: linking ? palette.accent : palette.stroke,
      sw: linking ? 1.5 : 1,
      id: item.id,
    });
    text(g, item.name, item.x, top + HDR_H / 2, {
      size: 13.5,
      color: palette.rootText,
      weight: 600,
      maxUnits: 20,
      maxLines: 1,
      id: item.id,
    });
    line(g, left, top + HDR_H, left + size.w, top + HDR_H, { stroke: palette.stroke, sw: 1 });

    let rowY = top + HDR_H + LINE_H / 2;
    for (const attr of item.attrs) {
      caption(g, attr, left + PAD_X, rowY, { size: 11.5, color: palette.text, id: item.id });
      rowY += LINE_H;
    }
    if (item.attrs.length && item.methods.length) {
      line(g, left, rowY - LINE_H / 2, left + size.w, rowY - LINE_H / 2, { stroke: palette.stroke, sw: 1 });
    }
    for (const method of item.methods) {
      caption(g, method, left + PAD_X, rowY, { size: 11.5, color: palette.edgeText, id: item.id });
      rowY += LINE_H;
    }

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

function panel(state: ClassChart, selected: string | null): ChartField[] {
  if (state.linking) {
    const source = itemById(state, state.linking);
    return [
      { kind: "note", text: t("chart.class.pickTarget", { name: source?.name ?? "" }) },
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
    return [
      { kind: "note", text: `${from?.name ?? "?"} → ${to?.name ?? "?"}` },
      {
        kind: "select",
        label: t("chart.class.relation"),
        value: edge.op,
        options: RELATION_GROUPS.map((entry) => ({ value: entry.op, label: t(entry.labelKey) })),
        apply: (value) => {
          if (value) edge.op = value;
        },
      },
      {
        kind: "text",
        label: t("chart.class.role"),
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
        label: t("chart.class.name"),
        value: item.name,
        apply: (value) => {
          const next = value.trim();
          if (next) item.name = next;
        },
      },
      {
        kind: "rows",
        label: t("chart.class.attributes"),
        value: item.attrs,
        placeholder: t("chart.class.attrPlaceholder"),
        apply: (value) => {
          item.attrs = value.filter((entry) => entry.trim().length > 0);
        },
      },
      {
        kind: "rows",
        label: t("chart.class.methods"),
        value: item.methods,
        placeholder: t("chart.class.methodPlaceholder"),
        apply: (value) => {
          item.methods = value.filter((entry) => entry.trim().length > 0);
        },
      },
      {
        kind: "button",
        label: t("chart.class.addRelation"),
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
    fields.push({ kind: "button", label: t("chart.deleteClass"), icon: "trash-2", apply: () => remove(state, item.id) });
    return fields;
  }

  return [
    { kind: "note", text: t("chart.class.empty") },
    { kind: "button", label: t("chart.class.addClass"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: ClassChart): string {
  const taken = state.items.map((i) => i.name);
  let index = state.items.length + 1;
  while (taken.includes(`Class${index}`)) index += 1;
  const id = nextId(state.items.map((i) => i.id), "c");
  const bounds = extend(state);
  state.items.push({
    id,
    name: `Class${index}`,
    attrs: ["+field: String"],
    methods: ["+method()"],
    x: bounds ? (bounds.x1 + bounds.x2) / 2 : 0,
    y: bounds ? bounds.y2 + 120 : 0,
  });
  return id;
}

function remove(state: ClassChart, id: string): void {
  if (state.edges.some((e) => e.id === id)) {
    state.edges = state.edges.filter((e) => e.id !== id);
    return;
  }
  if (!state.items.some((i) => i.id === id)) return;
  state.items = state.items.filter((i) => i.id !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.linking === id) state.linking = null;
}

export const classSpec: ChartSpec<ClassChart> = {
  id: "class",
  blank: () =>
    parse(
      [
        "classDiagram",
        "  class Animal {",
        "    +String name",
        "    +eat()",
        "  }",
        "  class Dog {",
        "    +bark()",
        "  }",
        "  Animal <|-- Dog",
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
      op: DEFAULT_OP,
      label: "",
    });
    state.linking = null;
    return true;
  },
  hints: () => ["chart.hint.drag", "chart.hint.class"],
};
