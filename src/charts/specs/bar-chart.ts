import { t } from "../../i18n";
import { caption, group, halo, line, nextId, seriesColor, seriesStroke, text, textWidth, box } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";
import type { Point } from "../../core/model";

/**
 * Bar charts.
 *
 * One series of vertical bars, each a `(label, value)` pair — the same shape of
 * data a pie chart holds, just laid out for comparison rather than share. The
 * interaction borrows from the mind map: a right-click menu adds and edits,
 * the top handle drags a bar's value up and down, and the body drags a bar
 * left and right to reorder it against its neighbours.
 *
 * Two things the syntax deliberately cannot say, so the editor does not offer:
 *
 *  - No stacked or grouped bars. One series only; a grouped chart would need a
 *    second dimension the `xychart-beta` `x-axis`/`bar` pair has no room for.
 *  - No negative values. A bar below the baseline would need a signed axis the
 *    serialiser cannot write, so the floor is 1 and dragging up from there only
 *    ever grows the bar.
 */

export interface Bar {
  id: string;
  label: string;
  value: number;
}

export interface BarChart {
  title: string;
  /** Y-axis caption, mirrors `xychart-beta`'s `y-axis "label" …` line. Optional. */
  yLabel: string;
  bars: Bar[];
}

/** A bar cannot be written back below this; a zero-value bar has no height. */
const FLOOR = 1;

/** Layout in model units. The chart owns its own coordinate space; `fit()` frames it. */
const M = { left: 88, right: 28, top: 44, bottom: 56 };
const PLOT_MIN_W = 360;
const SLOT_W = 92;
const BAR_MAX_W = 56;
const PLOT_H = 300;
/** Number of value steps drawn on the y axis. */
const Y_TICKS = 5;

const HEADER_RE = /^xychart-beta\b/i;
const TITLE_RE = /^title\s+"?(.*?)"?\s*$/i;
const XAXIS_RE = /^x-axis\b/i;
const YAXIS_RE = /^y-axis\b/i;
const BAR_RE = /^bar\b/i;

/** Pulls comma-separated items out of a `[ … ]` bracket, one entry per category. */
function parseList(line: string): string[] {
  const m = /\[([\s\S]*)\]/.exec(line);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

/** Pulls comma-separated numbers out of a `[ … ]` bracket, dropping non-positive junk. */
function parseValues(line: string): number[] {
  const m = /\[([\s\S]*)\]/.exec(line);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => Number.parseFloat(s.trim().replace(/^["']|["']$/g, "")))
    .filter((v) => Number.isFinite(v) && v > 0);
}

function create(): BarChart {
  return { title: "", yLabel: "", bars: [] };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parse(source: string): BarChart {
  const chart = create();
  const labels: string[] = [];
  const values: number[] = [];
  let seen = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    if (!seen && HEADER_RE.test(line)) {
      seen = true;
      continue;
    }
    if (TITLE_RE.test(line)) {
      chart.title = TITLE_RE.exec(line)![1].trim();
      continue;
    }
    if (XAXIS_RE.test(line)) {
      labels.push(...parseList(line));
      continue;
    }
    if (YAXIS_RE.test(line)) {
      const q = /["']([^"']*)["']/.exec(line);
      if (q) chart.yLabel = q[1];
      continue;
    }
    if (BAR_RE.test(line)) {
      values.push(...parseValues(line));
      continue;
    }
  }
  // Zip categories and values by position; a missing category falls back to its
  // ordinal, a missing value to the floor so a half-written block still renders.
  const count = Math.max(labels.length, values.length);
  for (let i = 0; i < count; i++) {
    const label = i < labels.length ? labels[i] : `${i + 1}`;
    const value = i < values.length ? values[i] : FLOOR;
    chart.bars.push({
      id: nextId(chart.bars.map((b) => b.id), "b"),
      label,
      value: Math.max(FLOOR, round(value)),
    });
  }
  return chart;
}

function axisMax(state: BarChart): number {
  const max = state.bars.reduce((acc, bar) => Math.max(acc, bar.value), 0);
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function plotWidth(state: BarChart): number {
  return Math.max(PLOT_MIN_W, state.bars.length * SLOT_W);
}
function modelWidth(state: BarChart): number {
  return M.left + plotWidth(state) + M.right;
}
function modelHeight(): number {
  return M.top + PLOT_H + M.bottom;
}

function blank(): BarChart {
  return parse(
    [
      "xychart-beta",
      '  title "月度支出"',
      "  x-axis [餐饮, 交通, 居住, 娱乐]",
      "  y-axis 0 --> 2000",
      "  bar [1200, 500, 2000, 800]",
    ].join("\n")
  );
}

function layout(): void {
  // Every coordinate is derived from the array in `render`, so nothing to precompute.
}

function serialize(state: BarChart): string {
  const lines = ["xychart-beta"];
  if (state.title) lines.push(`  title "${state.title}"`);
  lines.push(`  x-axis [${state.bars.map((bar) => bar.label).join(", ")}]`);
  const max = axisMax(state);
  lines.push(state.yLabel ? `  y-axis "${state.yLabel}" 0 --> ${max}` : `  y-axis 0 --> ${max}`);
  lines.push(`  bar [${state.bars.map((bar) => round(bar.value)).join(", ")}]`);
  return `${lines.join("\n")}\n`;
}

function extent(state: BarChart): Bounds | null {
  if (!state.bars.length) return null;
  return {
    x1: -M.left * 0.4,
    y1: -M.top * 0.6,
    x2: modelWidth(state) - M.right * 0.4,
    y2: modelHeight() - M.bottom * 0.2,
  };
}

function render(ctx: ChartRenderContext<BarChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const P = { x: M.left, y: M.top, w: plotWidth(state), h: PLOT_H };
  const top = axisMax(state);
  const yOf = (value: number): number => P.y + P.h - (value / top) * P.h;
  const n = state.bars.length;
  const slot = P.w / Math.max(1, n);
  const bw = Math.min(BAR_MAX_W, slot * 0.62);

  const root = group(layer, "mtk-chart-nodes");

  if (state.title) {
    text(root, state.title, P.x + P.w / 2, 22, { size: 14, color: palette.rootText, weight: 600, maxLines: 1 });
  }

  const zeroY = yOf(0);
  const axis = palette.text;

  // Y axis title, rotated to run up the left gutter (matches the reference chart).
  if (state.yLabel) {
    const yTitle = caption(root, state.yLabel, 0, 0, { size: 11, color: palette.edgeText, anchor: "middle" });
    yTitle.setAttribute("transform", `translate(${round(P.x - 46)},${round(P.y + P.h / 2)}) rotate(-90)`);
  }

  // Value ticks with short outward marks — no gridlines.
  for (let i = 0; i <= Y_TICKS; i++) {
    const value = (top / Y_TICKS) * i;
    const gy = yOf(value);
    line(root, P.x - 5, gy, P.x, gy, { stroke: axis, sw: 1 });
    caption(root, String(round(value)), P.x - 9, gy, { size: 10.5, color: palette.edgeText, anchor: "end" });
  }

  // The two axes, drawn as a clean L.
  line(root, P.x, yOf(top), P.x, zeroY, { stroke: axis, sw: 1.5 });
  line(root, P.x, zeroY, P.x + P.w, zeroY, { stroke: axis, sw: 1.5 });

  state.bars.forEach((bar, index) => {
    const cx = P.x + slot * (index + 0.5);
    const by = yOf(bar.value);
    const bh = Math.max(2, zeroY - by);
    const isSel = selected === bar.id || selected === `bar:${bar.id}` || selected === `val:${bar.id}`;
    const g = group(root, "mtk-chart-node");

    // Category tick on the x axis.
    line(root, cx, zeroY, cx, zeroY + 5, { stroke: axis, sw: 1 });

    if (isSel) halo(g, cx - bw / 2, by, bw, bh, palette.accent, 8);

    box(g, { x: cx - bw / 2, y: by, w: bw, h: bh, rx: 2, fill: seriesColor(palette, index), stroke: seriesStroke(index), id: `bar:${bar.id}` });

    // The value shows only while the bar is selected, so an untouched chart
    // reads as cleanly as the reference.
    if (isSel) caption(g, String(round(bar.value)), cx, by - 9, { size: 12, color: palette.text, weight: 600, id: `bar:${bar.id}` });

    // Category label, truncated to its slot so a long name cannot collide with the next bar.
    let lab = bar.label;
    let ls = 12;
    while (textWidth(lab, ls) > slot - 8 && lab.length > 1) lab = lab.slice(0, -1);
    if (lab !== bar.label) lab = lab.slice(0, -1) + "…";
    caption(g, lab, cx, zeroY + 19, { size: ls, color: palette.edgeText, id: `bar:${bar.id}` });

    if (!interactive) return;

    // Top handle: drag vertically to change the value (mind-map "resize the node").
    grip({
      id: `val:${bar.id}`,
      x: cx,
      y: by,
      r: 8,
      axis: "y",
      cursor: "ns-resize",
      begin: () => ({ value: bar.value, top }),
      drag: (_dx, dy, origin) => {
        const o = origin as { value: number; top: number };
        const per = P.h / o.top;
        bar.value = Math.max(FLOOR, Math.round(o.value - dy / per));
      },
    });

    // Body: drag horizontally to reorder against neighbours (mind-map "move the node").
    grip({
      id: `bar:${bar.id}`,
      x: cx,
      y: by + bh / 2,
      r: bh / 2 + 4,
      axis: "x",
      cursor: "grab",
      begin: () => ({ index, slotW: slot }),
      drag: (dx, _dy, origin) => {
        const o = origin as { index: number; slotW: number };
        const target = Math.min(n - 1, Math.max(0, o.index + Math.round(dx / o.slotW)));
        if (target !== o.index) {
          const arr = state.bars;
          const [moved] = arr.splice(o.index, 1);
          arr.splice(target, 0, moved);
          o.index = target;
        }
      },
    });
  });
}

function add(state: BarChart): string {
  const id = nextId(state.bars.map((b) => b.id), "b");
  const largest = state.bars.reduce((acc, b) => Math.max(acc, b.value), 0);
  const value = Math.max(FLOOR, Math.round(largest / 4) || 10);
  state.bars.push({ id, label: t("chart.bar.newBar"), value });
  return id;
}

function bareId(id: string): string {
  return id.startsWith("bar:") ? id.slice(4) : id.startsWith("val:") ? id.slice(4) : id;
}

function remove(state: BarChart, id: string): void {
  const bare = bareId(id);
  state.bars = state.bars.filter((b) => b.id !== bare);
}

function panel(state: BarChart, selected: string | null): ChartField[] {
  const bare = selected ? bareId(selected) : null;
  const bar = bare ? state.bars.find((b) => b.id === bare) : null;
  if (bar) {
    return [
      { kind: "note", text: t("chart.bar.valueHint") },
      {
        kind: "text",
        label: t("chart.bar.label"),
        value: bar.label,
        apply: (value) => {
          bar.label = value.trim();
        },
      },
      {
        kind: "number",
        label: t("chart.bar.value"),
        value: bar.value,
        min: FLOOR,
        apply: (value) => {
          if (Number.isFinite(value)) bar.value = Math.max(FLOOR, Math.round(value));
        },
      },
      { kind: "button", label: t("chart.deleteBar"), icon: "trash-2", apply: () => remove(state, bar.id) },
    ];
  }
  return [
    { kind: "note", text: state.title || t("chart.bar.empty") },
    {
      kind: "text",
      label: t("chart.bar.title"),
      value: state.title,
      apply: (value) => {
        state.title = value.trim();
      },
    },
    { kind: "button", label: t("chart.bar.addBar"), icon: "plus", apply: () => add(state) },
  ];
}

export const barSpec: ChartSpec<BarChart> = {
  id: "bar",
  blank,
  parse,
  layout,
  render,
  serialize,
  panel,
  add,
  remove,
  extent,
  summary: (state: BarChart) => ({ nodes: state.bars.length, edges: 0 }),
  onDoubleClick: (state: BarChart, _point: Point): string | null => add(state),
  fit: { maxScale: 1.6 },
};
