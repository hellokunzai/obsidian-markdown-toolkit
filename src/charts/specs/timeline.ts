import { t } from "../../i18n";
import { boxAt, caption, group, halo, line, nextId, polygon, text, textWidth } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Timelines.
 *
 * A slot is a period and the events under it are what happened then, so
 * dragging an event card sideways does not move it — it re-assigns which period
 * it belongs to. The card snaps to the slot it lands nearest, because "between
 * 2026-01 and 2026-03" is not a thing the syntax can say.
 */

interface TimelineEvent {
  id: string;
  text: string;
}

interface TimeSlot {
  id: string;
  period: string;
  events: TimelineEvent[];
}

interface TimelineChart {
  title: string;
  slots: TimeSlot[];
  passthrough: string[];
}

const HEADER_RE = /^timeline\b/i;
const TITLE_RE = /^title\s+(.+)$/i;

const CARD_W = 148;
const CARD_H = 30;
const PILL_W = 118;
const PILL_H = 26;
const TOP_Y = 62;
const LEVEL_GAP = 46;
const MIN_COL = 182;

function create(): TimelineChart {
  return { title: "", slots: [], passthrough: [] };
}

function parse(source: string): TimelineChart {
  const chart = create();
  let seenHeader = false;
  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;
    if (!seenHeader && HEADER_RE.test(current)) {
      seenHeader = true;
      const title = TITLE_RE.exec(current);
      if (title) chart.title = title[1].trim();
      continue;
    }
    const title = TITLE_RE.exec(current);
    if (title) {
      chart.title = title[1].trim();
      continue;
    }
    if (current.startsWith("%%") || /^section\b/i.test(current)) {
      chart.passthrough.push(current);
      continue;
    }
    const parts = current.split(/\s*:\s*/).map((entry) => entry.trim()).filter(Boolean);
    if (parts.length < 2) {
      chart.passthrough.push(current);
      continue;
    }
    const slot: TimeSlot = { id: nextId(chart.slots.map((s) => s.id), "t"), period: parts[0], events: [] };
    for (const label of parts.slice(1)) {
      slot.events.push({ id: nextId(allEvents(chart).concat(slot.events).map((e) => e.id), "v"), text: label });
    }
    chart.slots.push(slot);
  }
  return chart;
}

function allEvents(chart: TimelineChart): TimelineEvent[] {
  return chart.slots.reduce<TimelineEvent[]>((list, slot) => list.concat(slot.events), []);
}

function serialize(chart: TimelineChart): string {
  const out = ["timeline"];
  if (chart.title) out.push(`  title ${chart.title}`);
  for (const slot of chart.slots) {
    const labels = slot.events.map((event) => event.text);
    out.push(`  ${[slot.period, ...labels].join(" : ")}`);
  }
  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function columnWidth(chart: TimelineChart): number {
  const widest = chart.slots.reduce((max, slot) => Math.max(max, textWidth(slot.period, 13)), 0);
  return Math.max(MIN_COL, widest + 74);
}

function layout(): void {
  // Column positions are index * columnWidth, derived at render time.
}

/** Vertical stacking for a slot's cards: alternating above and below the axis. */
function cardOffset(index: number): number {
  const level = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  return side * (TOP_Y + level * LEVEL_GAP);
}

function extend(chart: TimelineChart): Bounds | null {
  if (!chart.slots.length) return null;
  const col = columnWidth(chart);
  const deepest = chart.slots.reduce((max, slot) => Math.max(max, slot.events.length), 0);
  const reach = deepest ? Math.abs(cardOffset(deepest - 1)) + CARD_H / 2 + 16 : TOP_Y;
  return {
    x1: -col / 2 - CARD_W / 2 + 20,
    y1: -reach - 16,
    x2: (chart.slots.length - 1) * col + col / 2 + CARD_W / 2 - 20,
    y2: reach + 16,
  };
}

function render(ctx: ChartRenderContext<TimelineChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const col = columnWidth(state);
  const axis = group(layer, "mtk-chart-axis");
  const cards = group(layer, "mtk-chart-nodes");

  const first = -col / 2 + 20;
  const last = (state.slots.length - 1) * col + col / 2 - 20;

  line(axis, first, 0, last, 0, { stroke: palette.stroke, sw: 1.4 });
  // Arrow head so the axis reads as "and then".
  polygon(axis, `${last},0 ${last - 9},-4.5 ${last - 9},4.5`, { fill: palette.stroke, stroke: palette.stroke });
  line(axis, first, 0, first - 10, 0, { stroke: palette.stroke, sw: 1.4 });

  state.slots.forEach((slot, index) => {
    const x = index * col;
    const g = group(cards, "mtk-chart-node");

    if (selected === slot.id) halo(g, x - PILL_W / 2, -PILL_H / 2, PILL_W, PILL_H, palette.accent, 14);
    boxAt(g, x, 0, PILL_W, PILL_H, {
      rx: PILL_H / 2,
      fill: palette.rootFill,
      stroke: palette.accent,
      sw: 1.2,
      id: slot.id,
    });
    text(g, slot.period, x, 0, { size: 13, color: palette.rootText, maxUnits: 12, maxLines: 1, id: slot.id });

    if (interactive) {
      grip({
        id: slot.id,
        x,
        y: 0,
        r: PILL_W / 2,
        axis: "none",
        cursor: "pointer",
        begin: () => ({ index }),
        drag: () => undefined,
      });
    }

    slot.events.forEach((event, eventIndex) => {
      const cy = cardOffset(eventIndex);
      const cardX = x;
      // A connector from the axis out to the card. Drawn before the card so the
      // card's fill hides the last few pixels of the line.
      line(cards, x, Math.sign(cy) * PILL_H / 2, x, cy - Math.sign(cy) * CARD_H / 2, {
        stroke: palette.stroke,
        sw: 1,
      });

      const card = group(cards, "mtk-chart-node");
      if (selected === event.id) {
        halo(card, cardX - CARD_W / 2, cy - CARD_H / 2, CARD_W, CARD_H, palette.accent, 7);
      }
      boxAt(card, cardX, cy, CARD_W, CARD_H, {
        rx: 7,
        fill: palette.fill,
        stroke: palette.stroke,
        id: event.id,
      });
      text(card, event.text, cardX, cy, {
        size: 12,
        color: palette.text,
        maxUnits: 14,
        maxLines: 1,
        id: event.id,
      });

      if (!interactive) return;
      grip({
        id: event.id,
        x: cardX,
        y: cy,
        r: CARD_W / 2 + 4,
        axis: "x",
        cursor: "ew-resize",
        begin: () => ({ x: cardX }),
        drag: (dx, _dy, origin) => {
          const start = origin as { x: number };
          const target = Math.max(
            0,
            Math.min(state.slots.length - 1, Math.round((start.x + dx) / col))
          );
          const owner = state.slots.find((entry) => entry.events.includes(event));
          const destination = state.slots[target];
          if (!owner || !destination || owner === destination) return;
          owner.events = owner.events.filter((entry) => entry !== event);
          destination.events.push(event);
        },
      });
    });
  });
}

function panel(state: TimelineChart, selected: string | null): ChartField[] {
  const owner = state.slots.find((slot) => slot.events.some((event) => event.id === selected));
  const event = owner?.events.find((entry) => entry.id === selected);
  if (owner && event) {
    return [
      { kind: "note", text: t("chart.timeline.inSlot", { period: owner.period }) },
      {
        kind: "text",
        label: t("chart.timeline.event"),
        value: event.text,
        apply: (value) => {
          const next = value.trim();
          if (next) event.text = next;
        },
      },
      { kind: "note", text: t("chart.timeline.dragHint") },
      { kind: "button", label: t("chart.deleteEvent"), icon: "trash-2", apply: () => remove(state, event.id) },
    ];
  }

  const slot = state.slots.find((entry) => entry.id === selected);
  if (slot) {
    return [
      {
        kind: "text",
        label: t("chart.timeline.period"),
        value: slot.period,
        apply: (value) => {
          const next = value.trim();
          if (next) slot.period = next;
        },
      },
      { kind: "button", label: t("chart.timeline.addEvent"), icon: "plus", apply: () => addEvent(state, slot) },
      { kind: "button", label: t("chart.deletePeriod"), icon: "trash-2", apply: () => remove(state, slot.id) },
    ];
  }

  return [
    { kind: "note", text: t("chart.timeline.empty") },
    { kind: "button", label: t("chart.timeline.addPeriod"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: TimelineChart): string {
  const index = state.slots.length + 1;
  const id = nextId(state.slots.map((s) => s.id), "t");
  state.slots.push({
    id,
    period: t("chart.timeline.newPeriod", { n: String(index) }),
    events: [{ id: nextId(allEvents(state).map((e) => e.id), "v"), text: t("chart.timeline.newEvent") }],
  });
  return id;
}

function addEvent(state: TimelineChart, slot: TimeSlot): string {
  const id = nextId(allEvents(state).map((e) => e.id), "v");
  slot.events.push({ id, text: t("chart.timeline.newEvent") });
  return id;
}

function remove(state: TimelineChart, id: string): void {
  const owner = state.slots.find((slot) => slot.events.some((event) => event.id === id));
  if (owner) {
    owner.events = owner.events.filter((event) => event.id !== id);
    return;
  }
  state.slots = state.slots.filter((slot) => slot.id !== id);
}

export const timelineSpec: ChartSpec<TimelineChart> = {
  id: "timeline",
  blank: () =>
    parse(
      [
        "timeline",
        "  title 项目里程碑",
        "  2026-01 : 立项 : 可行性评审",
        "  2026-03 : 开发启动",
        "  2026-06 : 上线 : 复盘",
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
  summary: (state) => ({
    nodes: state.slots.length,
    edges: state.slots.reduce((n, slot) => n + slot.events.length, 0),
  }),
  hints: () => ["chart.hint.timeline"],
};
