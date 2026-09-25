import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { boxAt, caption, group, halo, line, nextId, text, textWidth } from "../draw";
import type { MarkerName } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Sequence diagrams.
 *
 * Two drags, and both of them change *order* rather than position — which is
 * the whole point of this diagram type. Dragging a participant moves its column;
 * dragging a message moves it up or down the exchange. Neither is free
 * positioning: a message halfway between two rows would be a picture of an
 * ordering that the syntax cannot express, so both snap.
 */

interface Actor {
  id: string;
  /** The identifier the syntax uses (`A` in `participant A as Client`). */
  key: string;
  /** What the reader sees. */
  label: string;
  x: number;
}

interface Message {
  id: string;
  from: string;
  to: string;
  text: string;
  /** Kept verbatim so a save never rewrites `-->>` into `->>`. */
  arrow: string;
  y: number;
}

interface SequenceChart {
  actors: Actor[];
  messages: Message[];
  passthrough: string[];
  /** Derived by `layout`: column width, row height, first row's y. */
  metrics: { colW: number; rowH: number; top: number; bottom: number };
  selection: string | null;
}

const HEADER_RE = /^sequenceDiagram\b/i;
const PART_RE = /^(?:participant|actor)\s+([A-Za-z0-9_\u4e00-\u9fa5-]+)(?:\s+as\s+(.+))?$/;
const ARROWS = ["-->>", "-->", "--x", "--\\)", "->>", "->", "-x", "-\\)"];
const MSG_RE = new RegExp(
  `^([A-Za-z0-9_\\u4e00-\\u9fa5-]+)\\s*(${ARROWS.join("|")})\\s*([A-Za-z0-9_\\u4e00-\\u9fa5-]+)\\s*:\\s*([\\s\\S]*)$`
);

const ROW_H = 44;
const HEAD_H = 32;

function create(): SequenceChart {
  return {
    actors: [],
    messages: [],
    passthrough: [],
    metrics: { colW: 160, rowH: ROW_H, top: 46, bottom: 120 },
    selection: null,
  };
}

function parse(source: string): SequenceChart {
  const chart = create();
  const byKey = new Map<string, Actor>();

  const ensure = (raw: string, label?: string): Actor => {
    const key = raw.trim();
    const found = byKey.get(key);
    if (found) {
      if (label) found.label = label.trim();
      return found;
    }
    const actor: Actor = { id: nextId(chart.actors.map((a) => a.id), "p"), key, label: (label ?? key).trim(), x: 0 };
    chart.actors.push(actor);
    byKey.set(key, actor);
    return actor;
  };

  let seenHeader = false;
  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;
    if (!seenHeader && HEADER_RE.test(current)) {
      seenHeader = true;
      continue;
    }
    if (current.startsWith("%%")) {
      chart.passthrough.push(current);
      continue;
    }
    const part = PART_RE.exec(current);
    if (part) {
      ensure(part[1], part[2]);
      continue;
    }
    const msg = MSG_RE.exec(current);
    if (msg) {
      const from = ensure(msg[1]);
      const to = ensure(msg[3]);
      chart.messages.push({
        id: nextId(chart.messages.map((m) => m.id), "m"),
        from: from.id,
        to: to.id,
        text: msg[4].trim(),
        arrow: msg[2],
        y: 0,
      });
      continue;
    }
    chart.passthrough.push(current);
  }

  return chart;
}

function actorById(chart: SequenceChart, id: string): Actor | null {
  return chart.actors.find((a) => a.id === id) ?? null;
}

function serialize(chart: SequenceChart): string {
  const out = ["sequenceDiagram"];
  for (const actor of chart.actors) {
    out.push(actor.label === actor.key ? `  participant ${actor.key}` : `  participant ${actor.key} as ${actor.label}`);
  }
  for (const message of chart.messages) {
    const from = actorById(chart, message.from)?.key ?? "?";
    const to = actorById(chart, message.to)?.key ?? "?";
    out.push(`  ${from}${message.arrow}${to}: ${message.text}`);
  }
  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function layout(chart: SequenceChart): void {
  const widest = chart.actors.reduce((max, actor) => Math.max(max, textWidth(actor.label, 13)), 0);
  const colW = Math.max(150, widest + 62);
  const rowH = ROW_H;
  const top = 46;
  chart.actors.forEach((actor, index) => {
    actor.x = index * colW;
  });
  chart.messages.forEach((message, index) => {
    message.y = top + index * rowH;
  });
  chart.metrics = {
    colW,
    rowH,
    top,
    bottom: chart.messages.length ? top + (chart.messages.length - 1) * rowH + 40 : top + 40,
  };
}

function arrowStyle(arrow: string): { dash?: string; end?: MarkerName } {
  switch (arrow) {
    case "-->":
      return { dash: "5 4" };
    case "->>":
      return { end: "arrow" };
    case "-->>":
      return { dash: "5 4", end: "arrow" };
    case "-x":
      return { end: "cross" };
    case "--x":
      return { dash: "5 4", end: "cross" };
    case "-)":
      return { end: "arrow" };
    case "--)":
      return { dash: "5 4", end: "arrow" };
    default:
      return {};
  }
}

function extend(chart: SequenceChart): Bounds | null {
  if (!chart.actors.length) return null;
  const { colW, bottom } = chart.metrics;
  const half = colW / 2 + 24;
  return {
    x1: -half,
    y1: -HEAD_H,
    x2: (chart.actors.length - 1) * colW + half,
    y2: bottom + 18,
  };
}

function render(ctx: ChartRenderContext<SequenceChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const { bottom } = state.metrics;
  const lifeline = group(layer, "mtk-chart-lifelines");
  const wires = group(layer, "mtk-chart-edges");
  const heads = group(layer, "mtk-chart-nodes");

  for (const actor of state.actors) {
    line(lifeline, actor.x, HEAD_H / 2 + 2, actor.x, bottom, {
      stroke: palette.stroke,
      dash: "4 5",
      sw: 1,
    });
  }

  for (const message of state.messages) {
    const from = actorById(state, message.from);
    const to = actorById(state, message.to);
    if (!from || !to) continue;
    const style = arrowStyle(message.arrow);
    const y = message.y;
    line(wires, from.x, y, to.x, y, { stroke: palette.edge, dash: style.dash, markerEnd: style.end });
    // Click target: the visible line is one pixel thick.
    line(wires, from.x, y, to.x, y, { stroke: "transparent", sw: 14, id: message.id });

    const midX = (from.x + to.x) / 2;
    if (message.text) {
      text(wires, message.text, midX, y - 12, {
        size: 11.5,
        color: palette.edgeText,
        halo: palette.surface,
        maxUnits: 18,
        maxLines: 1,
        id: message.id,
      });
    }
    if (selected === message.id) {
      const pad = Math.abs(to.x - from.x) / 2 + 10;
      halo(wires, midX - pad, y - 24, pad * 2, 40, palette.accent, 8);
    }

    if (!interactive) continue;
    // Reordering, not moving: the row snaps to a slot, because a message
    // between two slots would be an ordering the syntax cannot write down.
    grip({
      id: message.id,
      x: midX,
      y,
      r: 12,
      axis: "y",
      cursor: "ns-resize",
      begin: () => ({ y: message.y }),
      drag: (_dx, dy, start) => {
        const origin = start as { y: number };
        const target = Math.max(
          0,
          Math.min(state.messages.length - 1, Math.round((origin.y + dy - state.metrics.top) / ROW_H))
        );
        const current = state.messages.indexOf(message);
        if (current < 0 || current === target) return;
        state.messages.splice(current, 1);
        state.messages.splice(target, 0, message);
        state.messages.forEach((entry, index) => {
          entry.y = state.metrics.top + index * ROW_H;
        });
      },
    });
  }

  for (const actor of state.actors) {
    const width = Math.max(96, textWidth(actor.label, 13) + 34);
    const top = -HEAD_H / 2;
    const g = group(heads, "mtk-chart-node");
    if (selected === actor.id) halo(g, actor.x - width / 2, top, width, HEAD_H, palette.accent, 8);
    boxAt(g, actor.x, 0, width, HEAD_H, {
      rx: 6,
      fill: palette.fill,
      stroke: palette.stroke,
      id: actor.id,
    });
    text(g, actor.label, actor.x, 0, {
      size: 13,
      color: palette.text,
      maxUnits: 14,
      maxLines: 1,
      id: actor.id,
    });

    if (!interactive) continue;
    grip({
      id: actor.id,
      x: actor.x,
      y: 0,
      r: width / 2 + 6,
      axis: "x",
      cursor: "ew-resize",
      begin: () => ({ x: actor.x }),
      drag: (dx, _dy, start) => {
        const origin = start as { x: number };
        const target = Math.max(
          0,
          Math.min(state.actors.length - 1, Math.round((origin.x + dx) / state.metrics.colW))
        );
        const current = state.actors.indexOf(actor);
        if (current < 0 || current === target) return;
        state.actors.splice(current, 1);
        state.actors.splice(target, 0, actor);
        state.actors.forEach((entry, index) => {
          entry.x = index * state.metrics.colW;
        });
      },
    });
  }
}

function panel(state: SequenceChart, selected: string | null): ChartField[] {
  const message = state.messages.find((m) => m.id === selected);
  if (message) {
    const from = actorById(state, message.from);
    const to = actorById(state, message.to);
    return [
      { kind: "note", text: `${from?.label ?? "?"} → ${to?.label ?? "?"}` },
      {
        kind: "select",
        label: t("chart.seq.arrow"),
        value: message.arrow,
        options: [
          { value: "->>", label: t("chart.seq.solidArrow") },
          { value: "-->>", label: t("chart.seq.dashedArrow") },
          { value: "->", label: t("chart.seq.solidLine") },
          { value: "-->", label: t("chart.seq.dashedLine") },
          { value: "-x", label: t("chart.seq.solidCross") },
          { value: "--x", label: t("chart.seq.dashedCross") },
        ],
        apply: (value) => {
          if (value) message.arrow = value;
        },
      },
      { kind: "button", label: t("chart.seq.swap"), icon: "arrow-left-right", apply: () => swap(state, message) },
      {
        kind: "text",
        label: t("chart.seq.text"),
        value: message.text,
        apply: (value) => {
          message.text = value;
        },
      },
      { kind: "button", label: t("chart.deleteMessage"), icon: "trash-2", apply: () => remove(state, message.id) },
    ];
  }

  const actor = selected ? actorById(state, selected) : null;
  if (actor) {
    return [
      {
        kind: "text",
        label: t("chart.seq.label"),
        value: actor.label,
        apply: (value) => {
          const next = value.trim();
          if (next) actor.label = next;
        },
      },
      {
        kind: "text",
        label: t("chart.seq.key"),
        value: actor.key,
        apply: (value) => {
          const next = value.trim();
          if (next) actor.key = next;
        },
      },
      { kind: "button", label: t("chart.deleteParticipant"), icon: "trash-2", apply: () => remove(state, actor.id) },
    ];
  }

  return [
    { kind: "note", text: t("chart.seq.empty") },
    { kind: "button", label: t("chart.seq.addParticipant"), icon: "plus", apply: () => add(state) },
  ];
}

/** Swapping the two ends is the common edit, and it keeps the arrow's own glyph. */
function swap(state: SequenceChart, message: Message): void {
  const from = message.from;
  message.from = message.to;
  message.to = from;
}

function add(state: SequenceChart): string {
  const taken = state.actors.map((a) => a.key);
  let index = state.actors.length + 1;
  while (taken.includes(`P${index}`)) index += 1;
  const id = nextId(state.actors.map((a) => a.id), "p");
  state.actors.push({ id, key: `P${index}`, label: `P${index}`, x: state.actors.length * state.metrics.colW });
  return id;
}

function remove(state: SequenceChart, id: string): void {
  if (state.messages.some((m) => m.id === id)) {
    state.messages = state.messages.filter((m) => m.id !== id);
    return;
  }
  if (!state.actors.some((a) => a.id === id)) return;
  state.actors = state.actors.filter((a) => a.id !== id);
  state.messages = state.messages.filter((m) => m.from !== id && m.to !== id);
}

export const sequenceSpec: ChartSpec<SequenceChart> = {
  id: "sequence",
  blank: () =>
    parse(
      [
        "sequenceDiagram",
        "  participant C as 客户端",
        "  participant S as 服务端",
        "  participant D as 数据库",
        "  C->>S: 提交请求",
        "  S->>D: 查询数据",
        "  D-->>S: 返回结果",
        "  S-->>C: 返回响应",
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
  summary: (state) => ({ nodes: state.actors.length, edges: state.messages.length }),
  hints: () => ["chart.hint.seq"],
};
