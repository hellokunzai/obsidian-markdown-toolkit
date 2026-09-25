import type { ChartCanvasId, Point } from "../core/model";
import type { Palette } from "../render/svg";

/**
 * The chart canvas contract.
 *
 * Mind maps and flowcharts are one shape of diagram — boxes joined by lines —
 * and share the editor in `src/editor`. The nine kinds below are not that
 * shape at all: a sequence diagram is columns and rows, a pie chart is sectors,
 * a gantt chart is bars on a time axis. Flattening them into a node-and-edge
 * graph would mean inventing semantics the mermaid syntax does not have, so
 * each declares its own state, its own layout and its own drag rules here.
 *
 * What they *do* share is everything around the drawing: the viewport, undo,
 * selection, the property panel, save and export. `editor/chart-panel.ts` owns
 * all of that and drives whichever spec is registered for the diagram's kind,
 * while `paint.ts` owns the one way a chart gets drawn into a surface.
 */

/** Canvas size in model units. */
export interface ChartSize {
  w: number;
  h: number;
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * A draggable grip.
 *
 * Deliberately opaque to the panel: the spec decides what "moving" this grip
 * means. A gantt bar moves its start date, a sequence participant swaps its
 * column, a pie boundary re-splits two sectors. The panel only routes pointer
 * deltas into `drag`.
 *
 * `begin` runs on pointer-down and its return value is handed back to every
 * `drag` call. That is what makes a drag relative to where it started: a bar
 * snaps to whole days from its original date rather than accumulating rounding
 * error one pointer event at a time.
 */
export interface ChartHandle {
  /** Stable identity. Written to `data-mtk` and used as the selection key. */
  id: string;
  /** Hit-test centre and radius, in model coordinates. */
  x: number;
  y: number;
  r: number;
  /** Which deltas this grip accepts; a bar that only slides freely uses "xy". */
  axis: "x" | "y" | "xy" | "none";
  /** Cursor to show while hovering this grip. */
  cursor?: string;
  /** Reads whatever the drag needs from before the move (start value, pair sum…). */
  begin(): unknown;
  drag(dx: number, dy: number, origin: unknown): void;
}

/** A field in the property panel. The panel renders these; specs declare them. */
export type ChartField =
  | { kind: "text"; label: string; value: string; placeholder?: string; apply(value: string): void }
  | { kind: "rows"; label: string; value: string[]; placeholder?: string; apply(value: string[]): void }
  | {
      kind: "select";
      label: string;
      value: string;
      options: Array<{ value: string; label: string }>;
      apply(value: string): void;
    }
  | { kind: "number"; label: string; value: number; min?: number; step?: number; apply(value: number): void }
  | { kind: "note"; text: string }
  /**
   * A button. Returning an id selects that element afterwards, which is how
   * "add a state" leaves the new state open in the property panel instead of
   * making the user find it on the canvas.
   */
  | { kind: "button"; label: string; icon?: string; apply(): string | void };

export interface ChartRenderContext<S> {
  layer: SVGGElement;
  state: S;
  palette: Palette;
  /** Currently selected grip id, or null. */
  selected: string | null;
  /** False for the read-only preview inside the note. */
  interactive: boolean;
  /** Registers a grip the user can drag. */
  grip(handle: ChartHandle): void;
}

export interface ChartSummary {
  nodes: number;
  edges: number;
}

export interface ChartSpec<S> {
  readonly id: ChartCanvasId;
  /** The state an empty or unparseable block starts from. */
  blank(): S;
  parse(text: string): S;
  /** Recomputes derived coordinates. Never called while the user is dragging. */
  layout(state: S): void;
  render(ctx: ChartRenderContext<S>): void;
  serialize(state: S): string;
  /** Fields shown for the current selection — or the whole-chart fields when null. */
  panel(state: S, selected: string | null): ChartField[];
  /** Adds one element and returns its id. */
  add(state: S): string;
  remove(state: S, id: string): void;
  extent(state: S): Bounds | null;
  summary(state: S): ChartSummary;
  /**
   * A click on blank canvas — used by charts where clicking *is* the edit
   * (a git graph inserts a commit on the lane you click).
   *
   * Clicking an existing element never reaches here: the renderer marks every
   * shape with `data-mtk`, so the panel resolves those by DOM hit-testing, which
   * is both simpler and more exact than re-deriving geometry in a second place.
   */
  onClick?(state: S, point: Point): string | null;
  /**
   * A click that landed on an element (its `data-mtk` id). Return true to take
   * over: the panel then leaves the selection alone and only repaints.
   *
   * This is what turns "select a state, then click another one" into a
   * transition without inventing a second canvas interaction for it.
   */
  onPick?(state: S, id: string, point: Point): boolean;
  /** A double-click on blank canvas. */
  onDoubleClick?(state: S, point: Point): string | null;
  /** Rows of hint text shown under the canvas. */
  hints(): string[];
}

/**
 * How a spec looks from outside itself.
 *
 * Each spec is written against its own state shape, and the panel only ever
 * passes back the same object it was handed, so the registry narrows once —
 * there, where the mapping is known to be correct — rather than pushing a cast
 * into all nine specs.
 */
export type RegisteredSpec = ChartSpec<unknown>;
