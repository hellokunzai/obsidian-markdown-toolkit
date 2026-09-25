import { t } from "../../i18n";
import { caption, el, group, halo, nextId, path, setAttrs, text, textWidth } from "../draw";
import { seriesColor, seriesStroke } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Pie charts.
 *
 * Two things this diagram deliberately does *not* do, both because the mermaid
 * syntax has no way to say them:
 *
 *  - No "explode this slice". There is no syntax for a detached slice, so an
 *    editor offering it would be offering an edit that cannot be written back.
 *  - No free-form angle dragging. Dragging a boundary re-splits the two slices
 *    it separates while keeping their **sum** constant, because the numbers in
 *    the file are shares of a whole: letting one boundary move on its own would
 *    silently change every other proportion in the chart.
 */

interface Slice {
  id: string;
  label: string;
  value: number;
}

interface PieChart {
  title: string;
  showData: boolean;
  slices: Slice[];
}

const TITLE_RE = /title\s+(.+)$/i;
const SLICE_RE = /^"?([^":]*)"?\s*:\s*([\d.]+)\s*$/;

const RADIUS = 108;
const LEGEND_X = RADIUS + 40;
const TWO_PI = Math.PI * 2;
/** No slice may be squeezed to nothing: a zero-value slice cannot be written back. */
const SLICE_FLOOR = 0.5;

function create(): PieChart {
  return { title: "", showData: false, slices: [] };
}

function parse(source: string): PieChart {
  const chart = create();
  let seenHeader = false;
  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;
    if (!seenHeader && /^pie\b/i.test(current)) {
      seenHeader = true;
      const title = TITLE_RE.exec(current);
      if (title) chart.title = title[1].trim().replace(/^"|"$/g, "");
      if (/\bshowData\b/i.test(current)) chart.showData = true;
      continue;
    }
    if (current.startsWith("%%")) continue;
    const slice = SLICE_RE.exec(current);
    if (slice) {
      const value = Number.parseFloat(slice[2]);
      if (Number.isFinite(value) && value > 0) {
        chart.slices.push({
          id: nextId(chart.slices.map((s) => s.id), "k"),
          label: slice[1].trim(),
          value,
        });
      }
    }
  }
  return chart;
}

function total(state: PieChart): number {
  return state.slices.reduce((sum, slice) => sum + slice.value, 0);
}

function serialize(state: PieChart): string {
  const head = `pie${state.showData ? " showData" : ""}${state.title ? ` title ${state.title}` : ""}`;
  const rows = state.slices.map((slice) => `  "${slice.label}" : ${round(slice.value)}`);
  return `${[head, ...rows].join("\n")}\n`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function layout(): void {
  // A pie has no positions to compute: every slice is derived from its share.
}

/** Start angle of slice `index`, measured clockwise from twelve o'clock. */
function angleAt(state: PieChart, index: number): number {
  const sum = total(state);
  if (sum <= 0) return -Math.PI / 2;
  let acc = 0;
  for (let i = 0; i < index; i++) acc += state.slices[i].value;
  return -Math.PI / 2 + (acc / sum) * TWO_PI;
}

function arcPath(from: number, to: number): string {
  const sweep = to - from;
  if (sweep >= TWO_PI - 0.001) {
    // A full circle cannot be expressed as a single arc: start and end would
    // coincide and the renderer would draw nothing.
    const a = from;
    const b = from + Math.PI;
    return (
      `M0 0 L${RADIUS * Math.cos(a)} ${RADIUS * Math.sin(a)} ` +
      `A${RADIUS} ${RADIUS} 0 1 1 ${RADIUS * Math.cos(b)} ${RADIUS * Math.sin(b)} ` +
      `A${RADIUS} ${RADIUS} 0 1 1 ${RADIUS * Math.cos(a)} ${RADIUS * Math.sin(a)} Z`
    );
  }
  const large = sweep > Math.PI ? 1 : 0;
  const x0 = RADIUS * Math.cos(from);
  const y0 = RADIUS * Math.sin(from);
  const x1 = RADIUS * Math.cos(to);
  const y1 = RADIUS * Math.sin(to);
  return `M0 0 L${x0} ${y0} A${RADIUS} ${RADIUS} 0 ${large} 1 ${x1} ${y1} Z`;
}

function extend(state: PieChart): Bounds | null {
  if (!state.slices.length) return null;
  const legendRight = state.slices.reduce((max, slice) => {
    return Math.max(max, LEGEND_X + 30 + textWidth(slice.label, 12.5) + 46);
  }, LEGEND_X);
  return { x1: -RADIUS - 12, y1: -RADIUS - 12, x2: Math.max(RADIUS + 12, legendRight), y2: RADIUS + 12 };
}

function render(ctx: ChartRenderContext<PieChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const wedges = group(layer, "mtk-chart-nodes");
  const legend = group(layer, "mtk-chart-labels");
  const sum = total(state);

  state.slices.forEach((slice, index) => {
    const from = angleAt(state, index);
    const to = angleAt(state, index + 1);
    const g = group(wedges, "mtk-chart-node");
    const isSelected = selected === slice.id;

    if (isSelected) {
      const mid = (from + to) / 2;
      halo(
        g,
        RADIUS * Math.cos(mid) - 40,
        RADIUS * Math.sin(mid) - 26,
        80,
        52,
        palette.accent,
        10
      );
    }

    path(g, arcPath(from, to), {
      fill: seriesColor(palette, index),
      stroke: seriesStroke(index),
      sw: 1,
      id: slice.id,
    });

    const share = sum > 0 ? slice.value / sum : 0;
    if (share > 0.05) {
      const mid = (from + to) / 2;
      const at = { x: RADIUS * 0.63 * Math.cos(mid), y: RADIUS * 0.63 * Math.sin(mid) };
      caption(g, `${Math.round(share * 100)}%`, at.x, at.y, {
        size: 12,
        color: "#ffffff",
        anchor: "middle",
        id: slice.id,
      });
    }
  });

  // Legend. Drawn as plain swatches: they are a key to the colours, not a
  // control, and offering a "hide this slice" checkbox would be a feature the
  // syntax cannot express.
  let rowY = -RADIUS + 14;
  state.slices.forEach((slice, index) => {
    const g = group(legend, "mtk-chart-legend");
    const swatch = el("rect");
    setAttrs(swatch, {
      x: LEGEND_X,
      y: rowY - 7,
      width: 12,
      height: 12,
      rx: 3,
      fill: seriesColor(palette, index),
      stroke: seriesStroke(index),
      "stroke-width": 1,
    });
    g.appendChild(swatch);
    caption(g, slice.label, LEGEND_X + 22, rowY, {
      size: 12.5,
      color: palette.text,
      id: slice.id,
    });
    caption(g, String(round(slice.value)), LEGEND_X + 22 + textWidth(slice.label, 12.5) + 16, rowY, {
      size: 12,
      color: palette.edgeText,
      id: slice.id,
    });
    rowY += 24;
  });

  if (state.title) {
    text(legend, state.title, 0, -RADIUS - 26, { size: 14, color: palette.rootText, weight: 600, maxLines: 1 });
  }

  if (!interactive) return;
  // Boundaries between slices, never the slices themselves: the grip only makes
  // sense as "re-split these two", which is the one edit the syntax supports.
  for (let index = 1; index < state.slices.length; index++) {
    const angle = angleAt(state, index);
    const x = RADIUS * Math.cos(angle);
    const y = RADIUS * Math.sin(angle);
    grip({
      id: `cut:${index}`,
      x,
      y,
      r: 15,
      axis: "xy",
      cursor: "grabbing",
      begin: () => {
        const before = state.slices.slice(0, index - 1).reduce((sum2, s) => sum2 + s.value, 0);
        const left = state.slices[index - 1];
        const right = state.slices[index];
        return { before, pair: left.value + right.value, left, right, total: total(state), x, y };
      },
      drag: (dx, dy, origin) => {
        const o = origin as {
          before: number;
          pair: number;
          left: Slice;
          right: Slice;
          total: number;
          x: number;
          y: number;
        };
        const target = Math.atan2(o.y + dy, o.x + dx);
        // Recover the share from the angle, then hand the remainder to the
        // neighbour. The pair's sum is untouched, so every other slice's
        // proportion stays exactly where it was.
        const share = ((target + Math.PI / 2) / TWO_PI) * o.total - o.before;
        const clamped = Math.min(o.pair - SLICE_FLOOR, Math.max(SLICE_FLOOR, share));
        o.left.value = round(clamped);
        o.right.value = round(o.pair - clamped);
      },
    });
  }
}

function panel(state: PieChart, selected: string | null): ChartField[] {
  const slice = state.slices.find((s) => s.id === selected);
  if (slice) {
    const sum = total(state);
    const share = sum > 0 ? Math.round((slice.value / sum) * 100) : 0;
    return [
      { kind: "note", text: t("chart.pie.share", { percent: String(share) }) },
      {
        kind: "text",
        label: t("chart.pie.label"),
        value: slice.label,
        apply: (value) => {
          slice.label = value;
        },
      },
      {
        kind: "number",
        label: t("chart.pie.value"),
        value: slice.value,
        min: SLICE_FLOOR,
        apply: (value) => {
          if (!Number.isFinite(value)) return;
          slice.value = Math.max(SLICE_FLOOR, round(value));
        },
      },
      { kind: "note", text: t("chart.pie.conserve") },
      { kind: "button", label: t("chart.deleteSlice"), icon: "trash-2", apply: () => remove(state, slice.id) },
    ];
  }

  return [
    { kind: "note", text: state.title || t("chart.pie.empty") },
    {
      kind: "text",
      label: t("chart.pie.title"),
      value: state.title,
      apply: (value) => {
        state.title = value.trim();
      },
    },
    { kind: "button", label: t("chart.pie.addSlice"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: PieChart): string {
  const id = nextId(state.slices.map((s) => s.id), "k");
  // A new slice takes a fifth of the largest one, so the total stays meaningful
  // instead of every insertion silently rescaling the whole chart.
  const largest = state.slices.reduce((max, s) => Math.max(max, s.value), 0);
  state.slices.push({ id, label: t("chart.pie.newSlice"), value: Math.max(SLICE_FLOOR, round(largest / 5) || 10) });
  return id;
}

function remove(state: PieChart, id: string): void {
  state.slices = state.slices.filter((s) => s.id !== id);
}

export const pieSpec: ChartSpec<PieChart> = {
  id: "pie",
  blank: () =>
    parse(
      [
        "pie title 时间分配",
        '  "工作" : 45',
        '  "学习" : 30',
        '  "休息" : 25',
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
  summary: (state) => ({ nodes: state.slices.length, edges: 0 }),
  hints: () => ["chart.hint.pie"],
};
