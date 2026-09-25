import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { boxAt, ellipse, group, halo, measureText, nextId, path, text } from "../draw";
import { elbowPath, layoutGraph, polylinePath, routeMidpoint } from "../graph-layout";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * State diagrams.
 *
 * The one semantic decision worth spelling out: `[*]` is not a node the user
 * owns. In mermaid it is a *derived* marker — the entry of a state is wherever
 * an edge leaves `[*]`, the exit is wherever one arrives. So they are modelled
 * as derived items (`start:<state>` / `end:<state>`), laid out with everything
 * else but never draggable, never selectable and never renamed. Making them
 * free-floating boxes would let the user build a diagram mermaid reads
 * differently from what is on screen.
 */

interface StateItem {
  id: string;
  /** Whatever the user sees and edits. */
  name: string;
  /** The identifier the syntax actually uses. Differs from `name` only when the
   *  label needs quoting (`state "等待确认" as st2`). */
  alias: string;
  x: number;
  y: number;
  /** Empty for a real state; otherwise which `[*]` marker this derived item is. */
  virtual: "" | "start" | "end";
  /** Owning state id, for a virtual item. */
  owner: string;
  pinned?: boolean;
}

interface StateEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface StateChart {
  items: StateItem[];
  edges: StateEdge[];
  /** Lines we do not model, echoed back on save so nothing is destroyed. */
  passthrough: string[];
  /** Transient: the state a pending transition starts from. Never serialised. */
  linking: string | null;
  /** Derived from the last layout. Never serialised. */
  routes: Map<string, Point[]>;
}

const HEADER_RE = /^stateDiagram(?:-v2)?\b/i;
const EDGE_RE = /^([\s\S]*?)\s*-->\s*([\s\S]*)$/;
/** `state "long label" as shortId` */
const DECL_RE = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_-]+)$/;
const IDENT_RE = /^[A-Za-z0-9_-]+$/;

const NODE_W = 24;

function create(): StateChart {
  return { items: [], edges: [], passthrough: [], linking: null, routes: new Map() };
}

function sizeOf(item: StateItem): { w: number; h: number } {
  if (item.virtual) return { w: NODE_W, h: NODE_W };
  return measureText(item.name || " ", 13, 18);
}

function parse(source: string): StateChart {
  const chart = create();
  const byAlias = new Map<string, StateItem>();

  const ensure = (raw: string): StateItem | null => {
    const value = raw.trim();
    if (!value) return null;
    const found = byAlias.get(value);
    if (found) return found;
    const item: StateItem = {
      id: nextId(chart.items.map((i) => i.id), "s"),
      name: value,
      alias: value,
      x: 0,
      y: 0,
      virtual: "",
      owner: "",
    };
    chart.items.push(item);
    byAlias.set(value, item);
    return item;
  };

  const virtualOf = (kind: "start" | "end", owner: StateItem): StateItem => {
    const id = `${kind}:${owner.id}`;
    const found = chart.items.find((i) => i.id === id);
    if (found) return found;
    const item: StateItem = { id, name: "", alias: "", x: 0, y: 0, virtual: kind, owner: owner.id };
    chart.items.push(item);
    return item;
  };

  let seenHeader = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!seenHeader && HEADER_RE.test(line)) {
      seenHeader = true;
      continue;
    }
    if (line.startsWith("%%")) {
      chart.passthrough.push(line);
      continue;
    }

    const decl = DECL_RE.exec(line);
    if (decl) {
      const item = ensure(decl[2]);
      if (item) {
        item.name = decl[1];
        item.alias = decl[2];
        byAlias.set(decl[1], item);
      }
      continue;
    }

    const match = EDGE_RE.exec(line);
    if (!match) {
      chart.passthrough.push(line);
      continue;
    }
    const fromRaw = match[1].trim();
    const rest = match[2];
    const colon = rest.indexOf(":");
    const toRaw = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
    const label = colon >= 0 ? rest.slice(colon + 1).trim() : "";
    if (!fromRaw || !toRaw) {
      chart.passthrough.push(line);
      continue;
    }

    let from: StateItem | null = null;
    let to: StateItem | null = null;
    if (fromRaw === "[*]" && toRaw !== "[*]") {
      const owner = ensure(toRaw);
      if (owner) {
        from = virtualOf("start", owner);
        to = owner;
      }
    } else if (toRaw === "[*]" && fromRaw !== "[*]") {
      const owner = ensure(fromRaw);
      if (owner) {
        from = owner;
        to = virtualOf("end", owner);
      }
    } else if (fromRaw !== "[*]" && toRaw !== "[*]") {
      from = ensure(fromRaw);
      to = ensure(toRaw);
    }
    if (!from || !to) {
      chart.passthrough.push(line);
      continue;
    }
    chart.edges.push({ id: nextId(chart.edges.map((e) => e.id), "e"), from: from.id, to: to.id, label });
  }

  return chart;
}

function itemById(chart: StateChart, id: string): StateItem | null {
  return chart.items.find((i) => i.id === id) ?? null;
}

/** The identifier an edge should use for an endpoint. */
function refOf(chart: StateChart, id: string): string {
  const item = itemById(chart, id);
  if (!item) return id;
  if (item.virtual) return "[*]";
  return item.alias || item.name || "unnamed";
}

function serialize(chart: StateChart): string {
  const out = ["stateDiagram-v2"];
  const referenced = new Set<string>();

  for (const edge of chart.edges) {
    for (const end of [edge.from, edge.to]) {
      const item = itemById(chart, end);
      if (item && !item.virtual) referenced.add(item.id);
    }
    const suffix = edge.label ? ` : ${edge.label}` : "";
    out.push(`  ${refOf(chart, edge.from)} --> ${refOf(chart, edge.to)}${suffix}`);
  }

  // A state with no transitions is still a state. Writing it back as its own
  // line is what keeps "add a state, save, reopen" from silently losing it.
  for (const item of chart.items) {
    if (item.virtual || referenced.has(item.id)) continue;
    out.push(item.name === item.alias ? `  ${item.alias}` : `  state "${item.name}" as ${item.alias}`);
  }

  // Declarations whose label needs quoting have to come before they are used,
  // but mermaid accepts them anywhere; keeping them last preserves the user's
  // own line order wherever the parser did understand the line.
  for (const item of chart.items) {
    if (item.virtual || !referenced.has(item.id)) continue;
    if (item.name === item.alias) continue;
    out.push(`  state "${item.name}" as ${item.alias}`);
  }

  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function layout(chart: StateChart): void {
  const nodes = chart.items.map((item) => {
    const size = sizeOf(item);
    return { id: item.id, w: size.w, h: size.h, pinned: item.pinned };
  });
  const edges = chart.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }));
  const result = layoutGraph(nodes, edges, { direction: "TD", nodeSep: 40, rankSep: 62 });
  for (const item of chart.items) {
    const point = result.positions.get(item.id);
    if (!point || item.pinned) continue;
    item.x = point.x;
    item.y = point.y;
  }
  chart.routes = result.routes;
}

/** Where a straight run from a box's centre leaves its own outline. */
function boundary(item: StateItem, toward: Point): Point {
  const size = sizeOf(item);
  const dx = toward.x - item.x;
  const dy = toward.y - item.y;
  if (!dx && !dy) return { x: item.x, y: item.y };
  const hw = size.w / 2;
  const hh = size.h / 2;
  const scale = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6));
  return { x: item.x + dx * scale, y: item.y + dy * scale };
}

/** Keeps dagre's elbow shape but snaps the ends onto the two boxes. */
function edgePath(chart: StateChart, edge: StateEdge): { d: string; from: Point; to: Point } | null {
  const a = itemById(chart, edge.from);
  const b = itemById(chart, edge.to);
  if (!a || !b) return null;
  const from = boundary(a, b);
  const to = boundary(b, a);
  const route = chart.routes.get(edge.id);
  if (!route || route.length < 2) return { d: elbowPath(from, to, "TD"), from, to };
  const points = [from, ...route.slice(1, -1), to];
  return { d: polylinePath(points), from, to };
}

function extend(chart: StateChart): Bounds | null {
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

function render(ctx: ChartRenderContext<StateChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const edgeLayer = group(layer, "mtk-chart-edges");
  const nodeLayer = group(layer, "mtk-chart-nodes");

  for (const edge of state.edges) {
    const geometry = edgePath(state, edge);
    if (!geometry) continue;
    path(edgeLayer, geometry.d, { stroke: palette.edge, markerEnd: "arrow" });
    // A transparent fat copy: a hairline is almost impossible to click, and
    // this is what makes "click the line to rename the event" work.
    path(edgeLayer, geometry.d, { stroke: "transparent", sw: 12, id: edge.id });
    if (edge.label) {
      const mid = routeMidpoint(state.routes.get(edge.id), geometry.from, geometry.to);
      text(edgeLayer, edge.label, mid.x, mid.y - 9, {
        size: 11.5,
        color: palette.edgeText,
        halo: palette.surface,
        maxUnits: 16,
        maxLines: 1,
      });
    }
    if (selected === edge.id) {
      const mid = routeMidpoint(state.routes.get(edge.id), geometry.from, geometry.to);
      ellipse(edgeLayer, { cx: mid.x, cy: mid.y, rx: 16, ry: 9, stroke: palette.accent, sw: 1.2 });
    }
  }

  for (const item of state.items) {
    const size = sizeOf(item);
    const box = group(nodeLayer, "mtk-chart-node");

    if (item.virtual) {
      ellipse(box, {
        cx: item.x,
        cy: item.y,
        rx: 7.5,
        ry: 7.5,
        fill: item.virtual === "start" ? palette.edge : palette.surface,
        stroke: palette.edge,
        sw: 1.6,
        id: item.id,
      });
      if (item.virtual === "end") {
        ellipse(box, { cx: item.x, cy: item.y, rx: 3.2, ry: 3.2, fill: palette.edge, id: item.id });
      }
      continue;
    }

    if (selected === item.id) {
      halo(box, item.x - size.w / 2, item.y - size.h / 2, size.w, size.h, palette.accent, 11);
    }
    const linking = state.linking === item.id;
    boxAt(box, item.x, item.y, size.w, size.h, {
      rx: 9,
      fill: linking ? palette.rootFill : palette.fill,
      stroke: linking ? palette.accent : palette.stroke,
      sw: linking ? 1.6 : 1,
      id: item.id,
    });
    text(box, item.name, item.x, item.y, {
      size: 13,
      color: palette.text,
      maxUnits: 18,
      maxLines: 2,
      id: item.id,
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

function panel(state: StateChart, selected: string | null): ChartField[] {
  if (state.linking) {
    const source = itemById(state, state.linking);
    return [
      { kind: "note", text: t("chart.state.pickTarget", { name: source?.name ?? "" }) },
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
      {
        kind: "note",
        text: `${from?.virtual ? "[*]" : from?.name ?? "?"} → ${to?.virtual ? "[*]" : to?.name ?? "?"}`,
      },
      {
        kind: "text",
        label: t("chart.state.event"),
        value: edge.label,
        placeholder: t("chart.state.eventPlaceholder"),
        apply: (value) => {
          edge.label = value;
        },
      },
      { kind: "button", label: t("chart.deleteTransition"), icon: "trash-2", apply: () => remove(state, edge.id) },
    ];
  }

  const item = selected ? itemById(state, selected) : null;
  if (item && !item.virtual) {
    const fields: ChartField[] = [
      {
        kind: "text",
        label: t("chart.state.name"),
        value: item.name,
        apply: (value) => {
          const next = value.trim();
          if (!next) return;
          item.name = next;
          if (IDENT_RE.test(next)) item.alias = next;
          else if (IDENT_RE.test(item.alias)) {
            /* keep the existing identifier; the label is quoted on save */
          }
        },
      },
      {
        kind: "button",
        label: t("chart.state.addTransition"),
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
    fields.push({ kind: "button", label: t("chart.deleteState"), icon: "trash-2", apply: () => remove(state, item.id) });
    return fields;
  }

  return [
    { kind: "note", text: t("chart.state.empty") },
    { kind: "button", label: t("chart.state.addState"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: StateChart): string {
  const id = nextId(state.items.map((i) => i.id), "s");
  const index = state.items.filter((i) => !i.virtual).length + 1;
  const alias = nextId(state.items.map((i) => i.alias), "S");
  const bounds = extend(state);
  state.items.push({
    id,
    name: t("chart.state.newName", { n: String(index) }),
    alias,
    x: bounds ? (bounds.x1 + bounds.x2) / 2 : 0,
    y: bounds ? bounds.y2 + 80 : 0,
    virtual: "",
    owner: "",
  });
  return id;
}

function remove(state: StateChart, id: string): void {
  const edge = state.edges.find((e) => e.id === id);
  if (edge) {
    state.edges = state.edges.filter((e) => e.id !== id);
    // Derived markers belong to the state, so an orphaned one has to go too.
    state.items = state.items.filter(
      (item) => !item.virtual || state.edges.some((e) => e.from === item.id || e.to === item.id)
    );
    return;
  }
  const item = itemById(state, id);
  if (!item || item.virtual) return;
  state.items = state.items.filter((i) => i.id !== id && i.owner !== id);
  state.edges = state.edges.filter((e) => e.from !== id && e.to !== id);
  if (state.linking === id) state.linking = null;
}

export const stateSpec: ChartSpec<StateChart> = {
  id: "state",
  blank: () => parse("stateDiagram-v2\n  [*] --> 待机\n  待机 --> 运行中 : 启动\n  运行中 --> 待机 : 暂停\n  运行中 --> [*] : 完成\n"),
  parse,
  layout,
  render,
  serialize,
  panel,
  add,
  remove,
  extent: extend,
  summary: (state) => ({ nodes: state.items.filter((i) => !i.virtual).length, edges: state.edges.length }),
  onClick: (state) => {
    if (!state.linking) return null;
    state.linking = null;
    return null;
  },
  onPick: (state, id) => {
    if (!state.linking) return false;
    const item = itemById(state, id);
    if (!item || item.virtual || item.id === state.linking) return false;
    state.edges.push({
      id: nextId(state.edges.map((e) => e.id), "e"),
      from: state.linking,
      to: item.id,
      label: "",
    });
    state.linking = null;
    return true;
  },
  hints: () => ["chart.hint.drag", "chart.hint.state"],
};
