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
}

const HEADER_RE = /^gantt\b/i;
const TITLE_RE = /^title\s+(.+)$/i;
const FORMAT_RE = /^dateFormat\s+(.+)$/i;
const SECTION_RE = /^section\s+(.+)$/i;
const TASK_RE = /^(.+?)\s*:\s*(.+)$/;

const DAY_W = 15;
const LABEL_W = 176;
const ROW_H = 32;
const SECTION_H = 26;
const BAR_H = 18;
const HEAD_H = 34;
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
  return { title: "", format: "YYYY-MM-DD", tasks: [], passthrough: [], axis: { minDay: 0, maxDay: 1 } };
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
  let y = HEAD_H;
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
  return {
    x: LABEL_W + (task.start - chart.axis.minDay) * DAY_W,
    w: Math.max(6, task.days * DAY_W),
  };
}

function extend(chart: GanttChart): Bounds | null {
  if (!chart.tasks.length) return null;
  const live = axisOf(chart);
  const min = Math.min(chart.axis.minDay, live.minDay);
  const max = Math.max(chart.axis.maxDay, live.maxDay);
  const last = chart.tasks[chart.tasks.length - 1];
  return {
    x1: 0,
    y1: 0,
    x2: LABEL_W + (max - chart.axis.minDay) * DAY_W + 24,
    y2: last.y + ROW_H,
  };
}

function render(ctx: ChartRenderContext<GanttChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const chartX = LABEL_W;
  const axis = state.axis;
  const span = Math.max(1, axis.maxDay - axis.minDay);
  const step = Math.max(1, Math.ceil(span / 12));
  const bottom = extend(state)?.y2 ?? HEAD_H + ROW_H;

  const axisLayer = group(layer, "mtk-chart-axis");
  const bars = group(layer, "mtk-chart-nodes");
  const labels = group(layer, "mtk-chart-labels");

  // Day grid. A tick every `step` days keeps a 90-day schedule readable where
  // a line per day would be a solid block of colour.
  for (let day = axis.minDay; day <= axis.maxDay; day += step) {
    const x = chartX + (day - axis.minDay) * DAY_W;
    line(axisLayer, x, HEAD_H, x, bottom, { stroke: palette.stroke, sw: 1, dash: "3 5" });
    caption(axisLayer, dayStr(day).slice(5), x + 3, HEAD_H / 2 + 4, {
      size: 10.5,
      color: palette.edgeText,
    });
  }
  line(axisLayer, chartX, HEAD_H, chartX + span * DAY_W, HEAD_H, { stroke: palette.stroke, sw: 1 });

  let section = "";
  for (const task of state.tasks) {
    if (task.section !== section) {
      section = task.section;
      if (section) {
        line(labels, 0, task.y - ROW_H / 2 - SECTION_H / 2 + 2, chartX + span * DAY_W, task.y - ROW_H / 2 - SECTION_H / 2 + 2, {
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

    caption(labels, task.name, chartX - 12, task.y, { size: 11.5, color: palette.text, anchor: "end", id: task.id });

    const { x, w } = barX(state, task);
    const g = group(bars, "mtk-chart-node");
    if (selected === task.id) halo(g, x, task.y - BAR_H / 2, w, BAR_H, palette.accent, 6);

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
    } else {
      box(g, { x, y: task.y - BAR_H / 2, w, h: BAR_H, rx: 5, fill, stroke, id: task.id });
      if (task.days >= 2) {
        caption(g, durationStr(task.days), x + w / 2, task.y, {
          size: 10.5,
          color: palette.edgeText,
          anchor: "middle",
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
        task.start = Math.round(origin.start + dx / DAY_W);
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
        task.days = Math.max(1, Math.round(origin.days + dx / DAY_W));
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
  summary: (state) => ({ nodes: state.tasks.length, edges: state.tasks.filter((task) => task.dep).length }),
  hints: () => ["chart.hint.gantt"],
};
