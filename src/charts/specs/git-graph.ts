import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { caption, el, group, halo, nextId, path, setAttrs } from "../draw";
import { seriesColor, seriesStroke } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Git graphs.
 *
 * The one diagram here with **no drag interaction**, and that is a decision
 * rather than an omission. Every other canvas drags an element to a new place;
 * but a commit's position *is* its history — column is "when", lane is "on
 * which branch". Dragging one across lanes would describe a rewrite of the
 * branch structure, which the `gitGraph` syntax has no way to express (it is a
 * sequence of `commit` / `branch` / `merge` commands, not a set of positions).
 * So the edit that replaces dragging is a click: click a lane, get a commit on
 * it, appended with the `checkout` that makes it land on the branch you picked.
 */

type GitEvent =
  | { t: "commit"; id: string; kind: string }
  | { t: "branch"; name: string }
  | { t: "checkout"; name: string }
  | { t: "merge"; name: string }
  | { t: "raw"; text: string };

interface CommitNode {
  id: string;
  lane: number;
  seq: number;
  parents: string[];
  kind: string;
  /**
   * Index of the event this node was replayed from.
   *
   * Recorded rather than derived from `seq`, because the two are not the same:
   * a `branch` or a `checkout` occupies an event slot without producing a
   * commit, so `events[commit.seq]` is a different command as soon as the
   * sequence contains one. Editing a merge's id, or deleting the merge commit,
   * went to the wrong event because of exactly that.
   */
  eventIndex: number;
}

interface GitChart {
  events: GitEvent[];
  /** Derived by `derive`. Never serialised. */
  commits: CommitNode[];
  lanes: string[];
}

const HEADER_RE = /^gitGraph\b/i;
const COMMIT_RE = /^commit(?:\s+(.+))?$/i;
const ID_RE = /id\s*:\s*"?([^",]+)"?/i;
const TYPE_RE = /type\s*:\s*([A-Z]+)/i;
const BRANCH_RE = /^branch\s+(.+)$/i;
const CHECKOUT_RE = /^(?:checkout|switch)\s+(.+)$/i;
const MERGE_RE = /^merge\s+(.+)$/i;

const COL_W = 64;
const LANE_H = 50;
const ORIGIN_X = 46;
const ORIGIN_Y = 64;
const R = 7.5;

function create(): GitChart {
  return { events: [], commits: [], lanes: ["main"] };
}

function parse(source: string): GitChart {
  const chart = create();
  let seenHeader = false;
  for (const raw of source.split(/\r?\n/)) {
    const current = raw.trim();
    if (!current) continue;
    if (!seenHeader && HEADER_RE.test(current)) {
      seenHeader = true;
      continue;
    }
    const commit = COMMIT_RE.exec(current);
    if (commit) {
      const meta = commit[1] ?? "";
      chart.events.push({
        t: "commit",
        id: (ID_RE.exec(meta)?.[1] ?? "").trim(),
        kind: (TYPE_RE.exec(meta)?.[1] ?? "NORMAL").toUpperCase(),
      });
      continue;
    }
    const branch = BRANCH_RE.exec(current);
    if (branch) {
      chart.events.push({ t: "branch", name: branch[1].trim() });
      continue;
    }
    const checkout = CHECKOUT_RE.exec(current);
    if (checkout) {
      chart.events.push({ t: "checkout", name: checkout[1].trim() });
      continue;
    }
    const merge = MERGE_RE.exec(current);
    if (merge) {
      chart.events.push({ t: "merge", name: merge[1].trim() });
      continue;
    }
    chart.events.push({ t: "raw", text: current });
  }
  derive(chart);
  return chart;
}

/**
 * Replays the command sequence into a set of commits.
 *
 * Everything the canvas needs — which lane a commit sits on, what it descends
 * from — is a *consequence* of the command order, so it is recomputed from the
 * events rather than stored. That is what makes inserting a commit anywhere in
 * the sequence come out right instead of leaving stale lanes behind.
 */
function derive(chart: GitChart): void {
  const lanes = ["main"];
  const heads: Array<string | null> = [null];
  const commits: CommitNode[] = [];
  const used = new Set<string>();
  let current = 0;

  const unique = (candidate: string): string => {
    let name = candidate;
    let n = 2;
    while (used.has(name)) {
      name = `${candidate}-${n}`;
      n += 1;
    }
    used.add(name);
    return name;
  };

  for (let i = 0; i < chart.events.length; i++) {
    const event = chart.events[i];
    if (event.t === "branch") {
      let index = lanes.indexOf(event.name);
      if (index < 0) {
        lanes.push(event.name);
        heads.push(heads[current] ?? null);
        index = lanes.length - 1;
      }
      // `branch x` means "create x **and switch to it**", which is what makes
      // the commits that follow land on the new lane. Creating the lane without
      // moving `current` left every one of them on the branch we came from, and
      // drew the new lane as an empty line — visible in the rendering long
      // before it was visible in the code.
      current = index;
      continue;
    }
    if (event.t === "checkout") {
      const index = lanes.indexOf(event.name);
      if (index >= 0) current = index;
      continue;
    }
    if (event.t === "commit") {
      const id = unique(event.id || `c${commits.length + 1}`);
      const parent = heads[current];
      commits.push({
        id,
        lane: current,
        seq: commits.length,
        parents: parent ? [parent] : [],
        kind: event.kind,
        eventIndex: i,
      });
      heads[current] = id;
      continue;
    }
    if (event.t === "merge") {
      const index = lanes.indexOf(event.name);
      const parents: string[] = [];
      const own = heads[current];
      const other = index >= 0 ? heads[index] : null;
      if (own) parents.push(own);
      if (other && other !== own) parents.push(other);
      const id = unique(`m${commits.length + 1}`);
      commits.push({ id, lane: current, seq: commits.length, parents, kind: "MERGE", eventIndex: i });
      heads[current] = id;
    }
  }

  chart.commits = commits;
  chart.lanes = lanes;
}

function serialize(chart: GitChart): string {
  const out = ["gitGraph"];
  for (const event of chart.events) {
    switch (event.t) {
      case "commit":
        out.push(event.id ? `  commit id: "${event.id}"${event.kind !== "NORMAL" ? ` type: ${event.kind}` : ""}` : "  commit");
        break;
      case "branch":
        out.push(`  branch ${event.name}`);
        break;
      case "checkout":
        out.push(`  checkout ${event.name}`);
        break;
      case "merge":
        out.push(`  merge ${event.name}`);
        break;
      default:
        out.push(`  ${event.text}`);
    }
  }
  return `${out.join("\n")}\n`;
}

function layout(): void {
  // Positions are a pure function of the replay: `seq` is the column and `lane`
  // the row, so there is nothing to compute ahead of time.
}

function pointOf(node: CommitNode): Point {
  return { x: ORIGIN_X + node.seq * COL_W, y: ORIGIN_Y + node.lane * LANE_H };
}

function laneIndexAt(chart: GitChart, y: number): number {
  const raw = Math.round((y - ORIGIN_Y) / LANE_H);
  return Math.max(0, Math.min(chart.lanes.length - 1, raw));
}

function extend(chart: GitChart): Bounds | null {
  if (!chart.commits.length && !chart.lanes.length) return null;
  const last = chart.commits[chart.commits.length - 1];
  return {
    x1: 0,
    y1: 12,
    x2: last ? last.seq * COL_W + ORIGIN_X + 90 : ORIGIN_X + 120,
    y2: Math.max(ORIGIN_Y + chart.lanes.length * LANE_H, (last?.lane ?? 0) * LANE_H + ORIGIN_Y + 50),
  };
}

function render(ctx: ChartRenderContext<GitChart>): void {
  const { layer, state, palette, selected } = ctx;
  const wires = group(layer, "mtk-chart-edges");
  const dots = group(layer, "mtk-chart-nodes");
  const gutter = group(layer, "mtk-chart-labels");

  state.lanes.forEach((name, index) => {
    const y = ORIGIN_Y + index * LANE_H;
    // The lane line makes the row a drop target the user can aim at.
    path(wires, `M${ORIGIN_X - 22} ${y} L${extend(state)?.x2 ?? 200} ${y}`, {
      stroke: palette.stroke,
      sw: 1,
      dash: "2 7",
    });
    caption(gutter, name, 4, y, { size: 12, color: palette.text, weight: 600 });
  });

  const byId = new Map(state.commits.map((c) => [c.id, c]));
  for (const commit of state.commits) {
    const at = pointOf(commit);
    for (const parentId of commit.parents) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      const from = pointOf(parent);
      const bend = Math.max(18, (at.x - from.x) / 2);
      path(wires, `M${from.x} ${from.y} C${from.x + bend} ${from.y} ${at.x - bend} ${at.y} ${at.x} ${at.y}`, {
        stroke: palette.edge,
        sw: 1.4,
      });
    }
  }

  state.commits.forEach((commit) => {
    const at = pointOf(commit);
    const g = group(dots, "mtk-chart-node");
    if (selected === commit.id) halo(g, at.x - 13, at.y - 13, 26, 26, palette.accent, 8);

    const fill = seriesColor(palette, commit.lane);
    const stroke = seriesStroke(commit.lane);

    if (commit.kind === "REVERSE") {
      // Hollow dot with a triangle inside — the "reverted" marker.
      const outer = el("circle");
      setAttrs(outer, { cx: at.x, cy: at.y, r: R + 1.5, fill: palette.surface, stroke, "stroke-width": 1.6, "data-mtk": commit.id });
      g.appendChild(outer);
      path(g, `M${at.x - 2.6} ${at.y - 3.6} L${at.x + 3.4} ${at.y} L${at.x - 2.6} ${at.y + 3.6} Z`, {
        fill,
        stroke,
        sw: 1,
        id: commit.id,
      });
    } else if (commit.kind === "HIGHLIGHT") {
      const box = el("rect");
      setAttrs(box, {
        x: at.x - R - 2,
        y: at.y - R - 2,
        width: (R + 2) * 2,
        height: (R + 2) * 2,
        rx: 3,
        fill: palette.surface,
        stroke: palette.accent,
        "stroke-width": 1,
        "stroke-dasharray": "3 2",
        "data-mtk": commit.id,
      });
      g.appendChild(box);
      const inner = el("rect");
      setAttrs(inner, {
        x: at.x - R + 1,
        y: at.y - R + 1,
        width: (R - 1) * 2,
        height: (R - 1) * 2,
        rx: 2,
        fill,
        stroke,
        "stroke-width": 1.2,
        "data-mtk": commit.id,
      });
      g.appendChild(inner);
    } else if (commit.kind === "MERGE") {
      const outer = el("circle");
      setAttrs(outer, { cx: at.x, cy: at.y, r: R + 1, fill: palette.surface, stroke, "stroke-width": 2, "data-mtk": commit.id });
      g.appendChild(outer);
      const inner = el("circle");
      setAttrs(inner, { cx: at.x, cy: at.y, r: 2.6, fill, "data-mtk": commit.id });
      g.appendChild(inner);
    } else {
      const dot = el("circle");
      setAttrs(dot, { cx: at.x, cy: at.y, r: R, fill, stroke, "stroke-width": 1.4, "data-mtk": commit.id });
      g.appendChild(dot);
    }

    caption(dots, commit.id, at.x, at.y - R - 9, {
      size: 10.5,
      color: palette.edgeText,
      anchor: "middle",
      id: commit.id,
    });
  });
}

function panel(state: GitChart, selected: string | null): ChartField[] {
  const commit = state.commits.find((c) => c.id === selected);
  if (commit) {
    const index = state.commits.findIndex((c) => c.id === selected);
    const event = state.events[commit.eventIndex];
    const isCommit = event?.t === "commit";
    const fields: ChartField[] = [
      { kind: "note", text: t("chart.git.position", { lane: state.lanes[commit.lane] ?? "-", n: String(index + 1) }) },
    ];
    if (isCommit) {
      fields.push({
        kind: "text",
        label: t("chart.git.id"),
        value: commit.id,
        apply: (value) => {
          const next = value.trim();
          if (next) event.id = next;
        },
      });
      fields.push({
        kind: "select",
        label: t("chart.git.kind"),
        value: commit.kind,
        options: [
          { value: "NORMAL", label: t("chart.git.normal") },
          { value: "REVERSE", label: t("chart.git.reverse") },
          { value: "HIGHLIGHT", label: t("chart.git.highlight") },
        ],
        apply: (value) => {
          if (value) event.kind = value;
        },
      });
    }
    fields.push({ kind: "note", text: t("chart.git.noDrag") });
    return fields;
  }

  return [
    { kind: "note", text: t("chart.git.empty") },
    { kind: "button", label: t("chart.git.addCommit"), icon: "plus", apply: () => add(state) },
    { kind: "button", label: t("chart.git.addBranch"), icon: "git-branch", apply: () => addBranch(state) },
  ];
}

/** Appends a commit on the currently checked-out lane. */
function add(state: GitChart): string {
  state.events.push({ t: "commit", id: nextId(state.commits.map((c) => c.id), "c"), kind: "NORMAL" });
  derive(state);
  return state.commits[state.commits.length - 1]?.id ?? "";
}

function addBranch(state: GitChart): string {
  const taken = new Set(state.lanes);
  let index = state.lanes.length;
  let name = `branch${index}`;
  while (taken.has(name)) {
    index += 1;
    name = `branch${index}`;
  }
  state.events.push({ t: "branch", name });
  derive(state);
  return "";
}

/** Which lane the sequence has left checked out. */
function currentLane(state: GitChart): number {
  let current = 0;
  const lanes = ["main"];
  for (const event of state.events) {
    if (event.t === "branch" && !lanes.includes(event.name)) lanes.push(event.name);
    if (event.t === "checkout") {
      const index = lanes.indexOf(event.name);
      if (index >= 0) current = index;
    }
  }
  return current;
}

function remove(state: GitChart, id: string): void {
  const commit = state.commits.find((c) => c.id === id);
  if (!commit) return;
  // The event it was replayed from, not the position in the commit list: a
  // `branch` or a `checkout` sits between the two and would otherwise be the
  // one that gets deleted — or, more often, the delete would silently do
  // nothing at all.
  const event = state.events[commit.eventIndex];
  if (event?.t !== "commit" && event?.t !== "merge") return;
  state.events.splice(commit.eventIndex, 1);
  derive(state);
}

export const gitSpec: ChartSpec<GitChart> = {
  id: "gitGraph",
  blank: () =>
    parse(
      [
        "gitGraph",
        '  commit id: "init"',
        "  branch develop",
        "  checkout develop",
        '  commit id: "feature"',
        "  checkout main",
        "  merge develop",
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
  summary: (state) => ({ nodes: state.commits.length, edges: state.commits.reduce((n, c) => n + c.parents.length, 0) }),
  onClick: (state, point) => {
    // Clicking *is* the edit here: it lands a commit on the lane you clicked,
    // prefixed with the `checkout` that makes the syntax put it there.
    const lane = laneIndexAt(state, point.y);
    const name = state.lanes[lane];
    if (!name) return null;
    if (currentLane(state) !== lane) state.events.push({ t: "checkout", name });
    state.events.push({ t: "commit", id: nextId(state.commits.map((c) => c.id), "c"), kind: "NORMAL" });
    derive(state);
    return state.commits[state.commits.length - 1]?.id ?? null;
  },
  hints: () => ["chart.hint.git"],
};
