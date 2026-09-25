import type { ChartCanvasId, DiagramMode } from "../core/model";
import { isCanvasMode } from "../core/model";
import type { ChartSpec, RegisteredSpec } from "./types";
import { classSpec } from "./specs/class-diagram";
import { erSpec } from "./specs/er-diagram";
import { ganttSpec } from "./specs/gantt";
import { gitSpec } from "./specs/git-graph";
import { ishikawaSpec } from "./specs/ishikawa";
import { pieSpec } from "./specs/pie";
import { sequenceSpec } from "./specs/sequence";
import { stateSpec } from "./specs/state-diagram";
import { timelineSpec } from "./specs/timeline";

/**
 * The nine canvases, keyed by kind.
 *
 * `Record<ChartCanvasId, …>` is the point: adding a tenth kind to the union in
 * `model.ts` without registering a spec here is a compile error, not a diagram
 * that silently renders as nothing.
 */
function loose<S>(spec: ChartSpec<S>): RegisteredSpec {
  return spec as unknown as RegisteredSpec;
}

const TABLE: Record<ChartCanvasId, RegisteredSpec> = {
  state: loose(stateSpec),
  class: loose(classSpec),
  er: loose(erSpec),
  sequence: loose(sequenceSpec),
  gantt: loose(ganttSpec),
  pie: loose(pieSpec),
  gitGraph: loose(gitSpec),
  timeline: loose(timelineSpec),
  ishikawa: loose(ishikawaSpec),
};

export function chartSpec(id: ChartCanvasId): RegisteredSpec {
  return TABLE[id];
}

/** True for a kind drawn by the generic node-and-edge editor. */
export { isCanvasMode };

/** True for a kind with a canvas of its own. */
export function isChartMode(mode: DiagramMode): mode is ChartCanvasId {
  return !isCanvasMode(mode);
}
