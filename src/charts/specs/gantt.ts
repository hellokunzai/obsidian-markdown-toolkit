import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { box, caption, group, halo, line, nextId, polygon, setAttrs, text, textWidth, el } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Gantt charts.
 *
 * Everything here is arithmetic on whole days. A bar's `start` is a day number
 * (days since the epoch), never a pixel, and a drag adds `Math.round(dx / DAY)`
 * to it — so a bar lands on the same date whether the canvas is 900px or 1600px
 * wide, and two "move one day right" gestures cannot drift apart by a fraction
 * that accumulates into a visibly wrong schedule.
 *
 * A dependency (`after a1`) is kept as a dependency until the user actually
 * drags that bar. Rewriting every `after` into a literal date on the first save
 * would quietly destroy the schedule's structure.
 */

interface GanttTask {
  id: string;
  /** The `a1` in `分析 :a1, 2026-09-01, 5d`, when the line names one. */
  key: string;
  /**
   * True when `key` is one we made up rather than one the file contains.
   *
   * Tracked explicitly instead of pattern-matching `g1`, `g2` on the way out:
   * a key the *user* chose is theirs to keep, and a heuristic cannot tell the
   * two apart — a task written as `构建 :g2, …` would lose its key on save.
   */
  autoKey: boolean;
  name: string;
  section: string;
  /** Days since epoch. */
  start: number;
  days: number;
  /** The task this one follows, until the user pins it to a date. */
  dep: string;
  /** Set once a drag assigns a real date; `dep` stops being written out. */
  manual: boolean;
  tags: string[];
  /** Derived row centre, filled by `layout`. */
  y: number;
}

interface GanttChart {
  title: string;
  /**
   * The `dateFormat` line, kept exactly as written.
   *
   * Only `YYYY-MM-DD` is *understood* — `dayNum` reads nothing else — but the
   * line belongs to the file, so it is echoed back rather than normalised. A
   * chart whose dates we cannot read should not also be a chart whose format
   * we silently rewrote. Owning the line here is also what stops it being
   * passed through *and* written out, which added a duplicate every save.
   */
  format: string;
  tasks: GanttTask[];
  passthrough: string[];
  /** The axis is only recomputed on layout, so a drag cannot rescale mid-gesture. */
  axis: { minDay: number; maxDay: number };
  /**
   * Pixels per day, filled by `render` from the surface width. A gantt chart is
   * a time axis, so it wants to spread across the column it is given rather than
   * sit at a fixed 15px/day that only reaches full width by being magnified
   * (which would also magnify the date labels and task names). 0 until `render`
   * has seen a width; `extent` and `barX` fall back to `DAY_W` then.
   */
  dayW: number;
}

const HEADER_RE = /^gantt\b/i;
const TITLE_RE = /^title\s+(.+)$/i;
const FORMAT_RE = /^dateFormat\s+(.+)$/i;
const SECTION_RE = /^section\s+(.+)$/i;
const TASK_RE = /^(.+?)\s*:\s*(.+)$/;

const DAY_W = 15;
/**
 * Fallback day width (px) used when no surface width is known — export, and any
 * caller that paints before the layout has settled. The live embed and editor
 * pass the real width in through `ChartRenderContext.width`, which overrides this.
 */
const ROW_H = 36;
const SECTION_H = 26;
const BAR_H = 26;
/** Title band at the top; the `title` line is drawn centred inside it. */
const TITLE_H = 34;
/** Date-label band under the rows; full `YYYY-MM-DD` captions live here. */
const AXIS_H = 26;
const KNOWN_TAGS = ["done", "active", "crit", "milestone"];

const DAY_MS = 86400000;

function p2(value: number): string {
  return `0${value}`.slice(-2);
}

/** `2026-09-01` → days since epoch, or null when it is not a plain date. */
export function dayNum(value: string): number | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
}

export function dayStr(day: number): string {
  const date = new Date(day * DAY_MS);
  return `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}`;
}

/** `5d` → 5, `2w` → 14, `3h` → 1. Anything else is null. */
function readDuration(value: string): number | null {
  const match = /^(\d+)\s*([dwmh])$/i.exec(value.trim());
  if (!match) return null;
  const count = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case "w":
      return count * 7;
    case "m":
      return count * 30;
    case "h":
      return Math.max(1, Math.round(count / 8));
    default:
      return count;
  }
}

function durationStr(days: number): string {
  return `${Math.max(1, Math.round(days))}d`;
}

function create(): GanttChart {
  return { title: "", format: "YYYY-MM-DD", tasks: [], passthrough: [], axis: { minDay: 0, maxDay: 1 }, dayW: 0 };
}

function parse(source: string): GanttChart {
  const chart = create();
  const byKey = new Map<string, GanttTask>();
  let section = "";
  let cursor = 0;
  let seenHeader = false;

  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;
    if (!seenHeader && HEADER_RE.test(current)) {
      seenHeader = true;
      continue;
    }
    const title = TITLE_RE.exec(current);
    if (title) {
      chart.title = title[1].trim();
      continue;
    }
    const format = FORMAT_RE.exec(current);
    if (format) {
      chart.format = format[1].trim();
      continue;
    }
    const groupMatch = SECTION_RE.exec(current);
    if (groupMatch) {
      section = groupMatch[1].trim();
      continue;
    }
    const task = TASK_RE.exec(current);
    if (!task) {
      chart.passthrough.push(current);
      continue;
    }

    const name = task[1].trim();
    const parts = task[2].split(",").map((entry) => entry.trim()).filter(Boolean);
    const tags: string[] = [];
    let key = "";
    let startDay: number | null = null;
    let duration: number | null = null;
    let dep = "";

    for (const part of parts) {
      const after = /^after\s+(.+)$/i.exec(part);
      if (after) {
        dep = after[1].trim();
        continue;
      }
      const date = dayNum(part);
      if (date !== null) {
        startDay = date;
        continue;
      }
      const span = readDuration(part);
      if (span !== null) {
        duration = span;
        continue;
      }
      if (KNOWN_TAGS.includes(part.toLowerCase())) tags.push(part.toLowerCase());
      else if (!key) key = part;
    }

    const followed = dep ? byKey.get(dep) : undefined;
    const resolved = startDay ?? (followed ? followed.start + followed.days : cursor);
    const length = duration ?? 1;
    // A generated key has to be unique among the keys already seen: `byKey`
    // is what a later `after …` resolves against, so a duplicate would
    // silently redirect the dependency to whichever task was parsed last.
    const generated = nextId(chart.tasks.map((entry) => entry.key), "g");
    const item: GanttTask = {
      id: nextId(chart.tasks.map((entry) => entry.id), "g"),
      key: key || generated,
      autoKey: !key,
      name,
      section,
      start: resolved,
      days: length,
      dep: followed ? dep : "",
      manual: !followed,
      tags,
      y: 0,
    };
    chart.tasks.push(item);
    if (key) byKey.set(key, item);
    else byKey.set(item.key, item);
    cursor = resolved + length;
  }

  return chart;
}

function taskById(chart: GanttChart, id: string): GanttTask | null {
  return chart.tasks.find((task) => task.id === id) ?? null;
}

function serialize(chart: GanttChart): string {
  const out = ["gantt"];
  if (chart.title) out.push(`  title ${chart.title}`);
  // Echoed from `chart.format`, not hardcoded: `parse` consumes this line, so
  // writing a literal here would both lose a format we cannot read and append
  // a second copy of it on every save.
  out.push(`  dateFormat ${chart.format}`);

  let section = "";
  for (const task of chart.tasks) {
    if (task.section !== section) {
      section = task.section;
      if (section) out.push(`  section ${section}`);
    }
    const meta: string[] = [];
    // `autoKey` is the flag, not a `/^g\d+$/` guess: a user who writes
    // `构建 :g2, …` means that key, and a pattern cannot tell it from ours.
    if (task.key && !task.autoKey) meta.push(task.key);
    if (task.dep && !task.manual) meta.push(`after ${task.dep}`);
    else meta.push(dayStr(task.start));
    meta.push(durationStr(task.days));
    out.push(`  ${task.name} :${meta.join(", ")}`);
  }

  out.push(...chart.passthrough);
  return `${out.join("\n")}\n`;
}

function axisOf(chart: GanttChart): { minDay: number; maxDay: number } {
  if (!chart.tasks.length) return { minDay: 0, maxDay: 7 };
  let min = Infinity;
  let max = -Infinity;
  for (const task of chart.tasks) {
    min = Math.min(min, task.start);
    max = Math.max(max, task.start + task.days);
  }
  return { minDay: min, maxDay: Math.max(min + 7, max) };
}

function layout(chart: GanttChart): void {
  chart.axis = axisOf(chart);
  let y = TITLE_H;
  let section = "";
  for (const task of chart.tasks) {
    if (task.section !== section) {
      section = task.section;
      if (section) y += SECTION_H;
    }
    task.y = y + ROW_H / 2;
    y += ROW_H;
  }
}

function barX(chart: GanttChart, task: GanttTask): { x: number; w: number } {
  const dw = chart.dayW > 0 ? chart.dayW : DAY_W;
  return {
    x: (task.start - chart.axis.minDay) * dw,
    w: Math.max(6, task.days * dw),
  };
}

function extend(chart: GanttChart): Bounds | null {
  if (!chart.tasks.length) return null;
  const live = axisOf(chart);
  const min = Math.min(chart.axis.minDay, live.minDay);
  const max = Math.max(chart.axis.maxDay, live.maxDay);
  const last = chart.tasks[chart.tasks.length - 1];
  const dw = chart.dayW > 0 ? chart.dayW : DAY_W;
  return {
    x1: 0,
    y1: 0,
    // The plot starts at day 0 of the axis and ends at the last grid line; no
    // extra margin here — the framing maths adds its own padding, and the first
    // and last date captions are anchored to the edges so they stay inside.
    x2: (max - chart.axis.minDay) * dw,
    y2: last.y + ROW_H / 2 + AXIS_H,
  };
}

function render(ctx: ChartRenderContext<GanttChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const axis = state.axis;
  const span = Math.max(1, axis.maxDay - axis.minDay);
  // Width-aware day width: when the surface reports a width, spread the axis
  // across it so bars fill the column instead of a fixed 15px/day model that
  // only reaches full width by being magnified (which also magnifies the text).
  // Without a width (export/legacy) it falls back to the fixed model width.
  const surfaceWidth = ctx.width ?? 0;
  const dayW = surfaceWidth > 0
    ? Math.max(8, surfaceWidth / span)
    : state.dayW > 0 ? state.dayW : DAY_W;
  state.dayW = dayW;
  const chartX = 0;
  // One vertical rule per day — the column is now wide enough for it.
  const step = 1;
  // A "YYYY-MM-DD" caption is ~56px wide; label every day the column fits one,
  // otherwise step just enough days that the captions no longer collide.
  const labelW = textWidth("0000-00-00", 10.5) + 6;
  const labelStep = dayW >= labelW ? 1 : Math.ceil(labelW / dayW);
  const plotBottom = state.tasks.length
    ? state.tasks[state.tasks.length - 1].y + ROW_H / 2
    : TITLE_H + ROW_H;

  const axisLayer = group(layer, "mtk-chart-axis");
  const bars = group(layer, "mtk-chart-nodes");
  const labels = group(layer, "mtk-chart-labels");

  // The `title` line, centred over the plot area.
  if (state.title) {
    caption(labels, state.title, chartX + (span * dayW) / 2, TITLE_H / 2, {
      size: 13,
      color: palette.edgeText,
      anchor: "middle",
      weight: 600,
    });
  }

  // Day grid. Solid verticals running from below the title through the rows
  // down to the axis band, one full date caption under its own line every
  // `labelStep` days (see above for why captions cannot reuse `step`).
  for (let day = axis.minDay; day <= axis.maxDay; day += step) {
    const x = chartX + (day - axis.minDay) * dayW;
    line(axisLayer, x, TITLE_H, x, plotBottom, { stroke: palette.edge, sw: 1 });
    if ((day - axis.minDay) % labelStep === 0) {
      // Centre-anchored: `labelStep` keeps consecutive captions far enough
      // apart not to collide, and the half-caption that hangs past the first
      // and last grid line lands in the framing padding, not off-canvas.
      caption(labels, dayStr(day), x, plotBottom + AXIS_H / 2, {
        size: 10.5,
        color: palette.edgeText,
        anchor: "middle",
      });
    }
  }

  let section = "";
  for (const task of state.tasks) {
    if (task.section !== section) {
      section = task.section;
      if (section) {
        line(labels, 0, task.y - ROW_H / 2 - SECTION_H / 2 + 2, chartX + span * dayW, task.y - ROW_H / 2 - SECTION_H / 2 + 2, {
          stroke: palette.stroke,
          sw: 1,
        });
        caption(labels, section, 4, task.y - ROW_H / 2 - SECTION_H / 2 + 2 + 12, {
          size: 11.5,
          color: palette.edgeText,
          weight: 600,
        });
      }
    }

    const { x, w } = barX(state, task);
    const g = group(bars, "mtk-chart-node");
    if (selected === task.id) halo(g, x, task.y - BAR_H / 2, w, BAR_H, palette.accent, 9);

    const done = task.tags.includes("done");
    const milestone = task.tags.includes("milestone");
    const fill = done ? palette.rootFill : palette.fill;
    const stroke = task.tags.includes("crit") ? palette.accent : palette.stroke;

    if (milestone) {
      const size = BAR_H;
      polygon(g, `${x},${task.y} ${x + size / 2},${task.y - size / 2} ${x + size},${task.y} ${x + size / 2},${task.y + size / 2}`, {
        fill,
        stroke,
        id: task.id,
      });
      // A diamond is too small to hold its name; read it from the right.
      caption(labels, task.name, x + size + 6, task.y, {
        size: 11,
        color: palette.text,
        anchor: "start",
      });
    } else {
      box(g, { x, y: task.y - BAR_H / 2, w, h: BAR_H, rx: 4, fill, stroke, id: task.id });
      // The task name lives inside the bar. A bar too short for its own name
      // (one-day tasks, mostly) reads it from the right edge instead.
      const inside = textWidth(task.name, 11) <= w - 10;
      if (inside) {
        // `done`'s tick occupies the left edge — slide the name past it.
        caption(g, task.name, x + w / 2 + (done ? 8 : 0), task.y, {
          size: 11,
          color: palette.text,
          anchor: "middle",
        });
      } else {
        caption(labels, task.name, x + w + 6, task.y, {
          size: 11,
          color: palette.text,
          anchor: "start",
        });
      }
      if (done) {
        // A check drawn as two strokes: mermaid shows completion the same way.
        const tick = el("path");
        setAttrs(tick, {
          d: `M${x + 6} ${task.y} l3.4 3.6 l6 -7.4`,
          fill: "none",
          stroke: palette.accent,
          "stroke-width": 1.6,
        });
        g.appendChild(tick);
      }
    }

    if (!interactive) continue;

    // The bar moves; the right edge resizes. Two grips on one shape is what
    // makes "shift this left by two days" and "make it two days longer"
    // different gestures instead of a modal choice.
    grip({
      id: `bar:${task.id}`,
      x: x + w / 2,
      y: task.y,
      r: BAR_H / 2 + 3,
      axis: "x",
      cursor: "grab",
      begin: () => ({ start: task.start }),
      drag: (dx, _dy, start) => {
        const origin = start as { start: number };
        // `dx` arrives in model coordinates (screen delta already divided by the
        // viewport scale), and the model is `dayW` px per day — not the legacy
        // 15px — so the day conversion must use the live `dayW`.
        task.start = Math.round(origin.start + dx / dayW);
        task.manual = true;
      },
    });
    grip({
      id: `rz:${task.id}`,
      x: x + w,
      y: task.y,
      r: 7,
      axis: "x",
      cursor: "ew-resize",
      begin: () => ({ days: task.days }),
      drag: (dx, _dy, start) => {
        const origin = start as { days: number };
        task.days = Math.max(1, Math.round(origin.days + dx / dayW));
        task.manual = true;
      },
    });

    // Resize handle, drawn on top of the bar so it reads as a grip.
    line(bars, x + w, task.y - BAR_H / 2 + 2, x + w, task.y + BAR_H / 2 - 2, {
      stroke: palette.accent,
      sw: 1.4,
      dash: "2 2",
      id: `rz:${task.id}`,
    });
  }
}

function panel(state: GanttChart, selected: string | null): ChartField[] {
  const barId = selected?.startsWith("bar:") ? selected.slice(4) : selected?.startsWith("rz:") ? selected.slice(3) : selected;
  const task = barId ? taskById(state, barId) : null;
  if (task) {
    return [
      {
        kind: "text",
        label: t("chart.gantt.name"),
        value: task.name,
        apply: (value) => {
          const next = value.trim();
          if (next) task.name = next;
        },
      },
      {
        kind: "text",
        label: t("chart.gantt.section"),
        value: task.section,
        apply: (value) => {
          task.section = value.trim();
        },
      },
      {
        kind: "text",
        label: t("chart.gantt.start"),
        value: dayStr(task.start),
        apply: (value) => {
          const day = dayNum(value);
          if (day === null) return;
          task.start = day;
          task.manual = true;
        },
      },
      {
        kind: "number",
        label: t("chart.gantt.days"),
        value: task.days,
        min: 1,
        apply: (value) => {
          if (!Number.isFinite(value)) return;
          task.days = Math.max(1, Math.round(value));
          task.manual = true;
        },
      },
      { kind: "note", text: t("chart.gantt.dragHint") },
      { kind: "button", label: t("chart.deleteTask"), icon: "trash-2", apply: () => remove(state, task.id) },
    ];
  }

  return [
    { kind: "note", text: t("chart.gantt.empty") },
    { kind: "button", label: t("chart.gantt.addTask"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: GanttChart): string {
  const last = state.tasks[state.tasks.length - 1];
  const start = last ? last.start + last.days : dayNum("2026-09-01") ?? 20000;
  const id = nextId(state.tasks.map((task) => task.id), "g");
  state.tasks.push({
    id,
    // The key exists so `after <key>` can find this row; it is never written
    // to the file (`autoKey`), so reusing the id keeps it unique for free.
    key: id,
    autoKey: true,
    name: t("chart.gantt.newTask"),
    section: last?.section ?? t("chart.gantt.defaultSection"),
    start,
    days: 5,
    dep: "",
    manual: true,
    tags: [],
    y: 0,
  });
  // The bare id, matching `remove(state, id)`. The `bar:` prefix belongs to
  // the grip's hit-test id, and the panel strips it before calling back in —
  // returning a prefixed id here made `remove` look up `bar:g3` and no-op.
  return id;
}

function remove(state: GanttChart, id: string): void {
  const target = taskById(state, id);
  if (!target) return;
  state.tasks = state.tasks.filter((task) => task.id !== id);
  for (const task of state.tasks) {
    if (task.dep && !state.tasks.some((entry) => entry.key === task.dep)) task.dep = "";
  }
}

export const ganttSpec: ChartSpec<GanttChart> = {
  id: "gantt",
  blank: () =>
    parse(
      [
        "gantt",
        "  title 项目排期",
        "  dateFormat YYYY-MM-DD",
        "  section 设计",
        "  需求分析 :d1, 2026-09-01, 5d",
        "  原型设计 :d2, after d1, 4d",
        "  section 开发",
        "  编码实现 :v1, 2026-09-10, 10d",
        "  联调测试 :v2, after v1, 5d",
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
  // A short schedule is a row of bars spanning the width it is given, not a
  // postage stamp centred in the canvas — lift the generic 1.15 framing cap
  // (see `ChartSpec.fit`) so the embed, the editor and the lightbox scale it
  // up to the available width instead of leaving the margins empty.
  fit: { maxScale: 3 },
  summary: (state) => ({ nodes: state.tasks.length, edges: state.tasks.filter((task) => task.dep).length }),
  /*
   * Hands every dependent bar back to the schedule.
   *
   * A dragged bar keeps an explicit date and sets `manual`, which is what makes
   * `serialize` write a date instead of `after …`. Releasing the flag is what
   * lets the dependency set the start again — one forward pass, the order
   * `parse` resolves them in, so a chain a → b → c settles in one go. A task
   * with no `after` has nothing to derive from and keeps its date.
   */
  tidy: (state) => {
    for (const task of state.tasks) {
      if (!task.dep) continue;
      const parent = state.tasks.find((other) => other.key === task.dep);
      if (!parent) continue;
      task.start = parent.start + parent.days;
      task.manual = false;
    }
  },
};
