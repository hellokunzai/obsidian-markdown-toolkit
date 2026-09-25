import { t } from "../../i18n";
import type { Point } from "../../core/model";
import { caption, group, halo, line, nextId, polygon, text, textWidth } from "../draw";
import type { Bounds, ChartField, ChartRenderContext, ChartSpec } from "../types";

/**
 * Fishbone (Ishikawa) diagrams.
 *
 * The body is an indented tree — the same shape a mind map parses — but nothing
 * else is shared with one, so it gets its own canvas: a horizontal spine with
 * the problem as the head, alternating bones leaning off it, and causes hanging
 * off each bone.
 *
 * Dragging a bone slides it along the spine, and sliding past a neighbour
 * reorders them. Rank is the only thing a bone's position can mean here; the
 * perpendicular distance from the spine is fixed by which side it was assigned.
 */

interface Cause {
  id: string;
  text: string;
}

interface Bone {
  id: string;
  text: string;
  /** -1 above the spine, 1 below. Assigned by index so the diagram alternates. */
  side: 1 | -1;
  causes: Cause[];
}

interface FishChart {
  problem: string;
  bones: Bone[];
}

const HEADER_RE = /^ishikawa(?:-beta)?\b/i;

const SPINE_W = 520;
const HEAD_W = 132;
const LEAN = 86;
const HEIGHT = 146;
const CAUSE_LEN = 40;

function parse(source: string): FishChart {
  const chart: FishChart = { problem: "", bones: [] };
  const items: Array<{ indent: number; text: string }> = [];
  let minIndent = Number.POSITIVE_INFINITY;
  let seenHeader = false;

  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const trimmed = raw.trim();
    if (!seenHeader && HEADER_RE.test(trimmed)) {
      seenHeader = true;
      continue;
    }
    if (trimmed.startsWith("%%")) continue;
    const indent = (raw.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "  ").length;
    minIndent = Math.min(minIndent, indent);
    items.push({ indent, text: trimmed });
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  const usedIds: string[] = [];
  let bone: Bone | null = null;

  for (const item of items) {
    const depth = Math.max(0, Math.round((item.indent - minIndent) / 2));
    if (depth === 0) {
      // Only the first level-0 line is the head; a second one would be a
      // mistake in the source, so it joins the problem rather than vanishing.
      chart.problem = chart.problem ? `${chart.problem} ${item.text}` : item.text;
      bone = null;
      continue;
    }
    if (depth === 1) {
      const id = nextId(usedIds, "b");
      usedIds.push(id);
      bone = { id, text: item.text, side: chart.bones.length % 2 === 0 ? -1 : 1, causes: [] };
      chart.bones.push(bone);
      continue;
    }
    if (!bone) continue;
    const id = nextId(usedIds, "u");
    usedIds.push(id);
    bone.causes.push({ id, text: item.text });
  }

  return chart;
}

function serialize(chart: FishChart): string {
  const out = ["ishikawa-beta"];
  out.push(`  ${chart.problem || t("chart.fish.problem")}`);
  for (const bone of chart.bones) {
    out.push(`    ${bone.text}`);
    for (const cause of bone.causes) out.push(`      ${cause.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** Horizontal spacing between bones along the spine. */
function gapOf(chart: FishChart): number {
  const count = Math.max(1, chart.bones.length);
  return (SPINE_W - 90) / count;
}

function boneBaseX(chart: FishChart, index: number): number {
  return 28 + gapOf(chart) * (index + 0.5);
}

function layout(chart: FishChart): void {
  // Side alternates strictly by index so reordering a bone also flips it — the
  // diagram stays balanced instead of piling every bone on one side.
  chart.bones.forEach((bone, index) => {
    bone.side = index % 2 === 0 ? -1 : 1;
  });
}

/** The far end of a bone: where it meets the spine is its base. */
function boneTip(chart: FishChart, index: number): Point {
  const base = boneBaseX(chart, index);
  const side = chart.bones[index]?.side ?? -1;
  return { x: base + LEAN, y: side * HEIGHT };
}

function causePoint(chart: FishChart, index: number, causeIndex: number): Point {
  const base = boneBaseX(chart, index);
  const side = chart.bones[index]?.side ?? -1;
  const count = chart.bones[index]?.causes.length ?? 0;
  const ratio = (causeIndex + 1) / (count + 1);
  return { x: base + LEAN * ratio, y: side * HEIGHT * ratio };
}

function extend(chart: FishChart): Bounds | null {
  if (!chart.problem && !chart.bones.length) return null;
  let x2 = SPINE_W + HEAD_W;
  let top = -HEIGHT - 40;
  let bottom = HEIGHT + 40;
  chart.bones.forEach((bone, index) => {
    bone.causes.forEach((cause, causeIndex) => {
      const at = causePoint(chart, index, causeIndex);
      const reach = at.y + bone.side * CAUSE_LEN;
      top = Math.min(top, reach - 14);
      bottom = Math.max(bottom, reach + 14);
      x2 = Math.max(x2, at.x + textWidth(cause.text, 11.5) / 2 + 16);
    });
    x2 = Math.max(x2, boneTip(chart, index).x + textWidth(bone.text, 12.5) / 2 + 10);
  });
  return { x1: 0, y1: top, x2, y2: bottom };
}

function render(ctx: ChartRenderContext<FishChart>): void {
  const { layer, state, palette, selected, interactive, grip } = ctx;
  const spine = group(layer, "mtk-chart-axis");
  const bones = group(layer, "mtk-chart-nodes");

  // Spine, drawn thick and with a head so the diagram reads left-to-right.
  line(spine, 0, 0, SPINE_W, 0, { stroke: palette.edge, sw: 2.4, id: state.problem ? "head" : undefined });
  polygon(spine, `${SPINE_W + 14},0 ${SPINE_W - 2},-7 ${SPINE_W - 2},7`, {
    fill: palette.edge,
    stroke: palette.edge,
    id: "head",
  });

  const headText = state.problem || t("chart.fish.problem");
  const headW = Math.max(HEAD_W, textWidth(headText, 13.5) + 34);
  const head = group(spine, "mtk-chart-node");
  if (selected === "head") halo(head, SPINE_W + 18, -19, headW, 38, palette.accent, 9);
  polygon(
    head,
    `${SPINE_W + 18},0 ${SPINE_W + 32},-19 ${SPINE_W + 18 + headW},-19 ` +
      `${SPINE_W + 18 + headW},19 ${SPINE_W + 32},19`,
    { fill: palette.rootFill, stroke: palette.accent, sw: 1.3, id: "head" }
  );
  text(head, headText, SPINE_W + 30 + headW / 2, 0, {
    size: 13.5,
    color: palette.rootText,
    weight: 600,
    maxUnits: 22,
    maxLines: 2,
    id: "head",
  });

  state.bones.forEach((bone, index) => {
    const base = boneBaseX(state, index);
    const tip = boneTip(state, index);
    const g = group(bones, "mtk-chart-node");
    const isSelected = selected === bone.id;

    line(g, base, 0, tip.x, tip.y, { stroke: palette.edge, sw: 1.8, id: bone.id });
    // Fat invisible copy: the bone is a hairline the user is meant to grab.
    line(g, base, 0, tip.x, tip.y, { stroke: "transparent", sw: 16, id: bone.id });

    text(g, bone.text, tip.x + 6, tip.y + bone.side * 12, {
      size: 12.5,
      color: palette.rootText,
      weight: 600,
      maxUnits: 12,
      maxLines: 2,
      id: bone.id,
    });
    if (isSelected) {
      halo(g, tip.x - 40, tip.y + bone.side * 12 - 14, 92, 28, palette.accent, 7);
    }

    bone.causes.forEach((cause, causeIndex) => {
      const at = causePoint(state, index, causeIndex);
      const outer = { x: at.x, y: at.y + bone.side * CAUSE_LEN };
      line(g, at.x, at.y, outer.x, outer.y, { stroke: palette.stroke, sw: 1.2, id: cause.id });
      text(g, cause.text, outer.x, outer.y + bone.side * 11, {
        size: 11.5,
        color: palette.text,
        maxUnits: 12,
        maxLines: 2,
        id: cause.id,
      });
      if (selected === cause.id) {
        const width = textWidth(cause.text, 11.5);
        halo(g, outer.x - width / 2 - 6, outer.y + bone.side * 11 - 12, width + 12, 24, palette.accent, 6);
      }
    });

    // `return`, not `continue`: this body is a `forEach` callback, and the only
    // thing left to do for a bone is register its grip.
    if (!interactive) return;
    grip({
      id: bone.id,
      x: (base + tip.x) / 2,
      y: tip.y / 2,
      r: 0,
      axis: "x",
      cursor: "ew-resize",
      begin: () => ({ index: state.bones.indexOf(bone) }),
      drag: (dx, _dy, origin) => {
        const start = origin as { index: number };
        const gap = gapOf(state);
        const current = state.bones.indexOf(bone);
        const target = Math.max(
          0,
          Math.min(state.bones.length - 1, Math.round(start.index + dx / gap))
        );
        if (current < 0 || current === target) return;
        state.bones.splice(current, 1);
        state.bones.splice(target, 0, bone);
        state.bones.forEach((entry, i) => {
          entry.side = i % 2 === 0 ? -1 : 1;
        });
      },
    });
  });
}

function panel(state: FishChart, selected: string | null): ChartField[] {
  if (selected === "head") {
    return [
      {
        kind: "text",
        label: t("chart.fish.problem"),
        value: state.problem,
        apply: (value) => {
          state.problem = value.trim();
        },
      },
      { kind: "button", label: t("chart.fish.addBone"), icon: "plus", apply: () => add(state) },
    ];
  }

  const owner = state.bones.find((bone) => bone.causes.some((cause) => cause.id === selected));
  const cause = owner?.causes.find((entry) => entry.id === selected);
  if (owner && cause) {
    return [
      { kind: "note", text: t("chart.fish.under", { bone: owner.text }) },
      {
        kind: "text",
        label: t("chart.fish.cause"),
        value: cause.text,
        apply: (value) => {
          const next = value.trim();
          if (next) cause.text = next;
        },
      },
      { kind: "button", label: t("chart.deleteCause"), icon: "trash-2", apply: () => remove(state, cause.id) },
    ];
  }

  const bone = state.bones.find((entry) => entry.id === selected);
  if (bone) {
    return [
      {
        kind: "text",
        label: t("chart.fish.bone"),
        value: bone.text,
        apply: (value) => {
          const next = value.trim();
          if (next) bone.text = next;
        },
      },
      { kind: "button", label: t("chart.fish.addCause"), icon: "plus", apply: () => addCause(state, bone) },
      { kind: "note", text: t("chart.fish.dragHint") },
      { kind: "button", label: t("chart.deleteBone"), icon: "trash-2", apply: () => remove(state, bone.id) },
    ];
  }

  return [
    { kind: "note", text: state.problem || t("chart.fish.empty") },
    { kind: "button", label: t("chart.fish.addBone"), icon: "plus", apply: () => add(state) },
  ];
}

function add(state: FishChart): string {
  const used = state.bones.reduce<string[]>((list, bone) => list.concat([bone.id]).concat(bone.causes.map((c) => c.id)), []);
  const id = nextId(used, "b");
  state.bones.push({
    id,
    text: t("chart.fish.newBone", { n: String(state.bones.length + 1) }),
    side: state.bones.length % 2 === 0 ? -1 : 1,
    causes: [],
  });
  return id;
}

function addCause(state: FishChart, bone: Bone): string {
  const used = state.bones.reduce<string[]>((list, entry) => list.concat([entry.id]).concat(entry.causes.map((c) => c.id)), []);
  const id = nextId(used, "u");
  bone.causes.push({ id, text: t("chart.fish.newCause") });
  return id;
}

function remove(state: FishChart, id: string): void {
  for (const bone of state.bones) {
    if (bone.causes.some((cause) => cause.id === id)) {
      bone.causes = bone.causes.filter((cause) => cause.id !== id);
      return;
    }
  }
  state.bones = state.bones.filter((bone) => bone.id !== id);
}

export const ishikawaSpec: ChartSpec<FishChart> = {
  id: "ishikawa",
  blank: () =>
    parse(
      [
        "ishikawa-beta",
        "  线上故障根因",
        "    基础设施",
        "      实例规格不足",
        "      缺少 CDN",
        "    代码变更",
        "      缺少回归测试",
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
    nodes: state.bones.length,
    edges: state.bones.reduce((n, bone) => n + bone.causes.length, 0),
  }),
  hints: () => ["chart.hint.fish"],
};
