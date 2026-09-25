import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { listFences, siblingFences } from "../block/block-target";
import { detectMode } from "../core/parse";
import { MERMAID_LANG, type DiagramMode } from "../core/model";
import { buildDiagramBox, type BuiltDiagramBox, type DiagramBoxHost } from "./box";
import type { DiagramBlockHost } from "./reading-processor";

/**
 * Drawing our diagrams inside the Live Preview editor.
 *
 * The registered code block processor in `reading-processor.ts` never gets to
 * see a mermaid block here: Obsidian's own Live Preview draws mermaid during an
 * earlier stage than plugin post processing, so by the time anything of ours
 * runs the fenced block is already an `<svg>`. That is why the same block was
 * ours in the reading view and Obsidian's in the editor — and why no amount of
 * checking "am I in the editor?" inside that processor could ever have put an
 * edit button on it.
 *
 * What takes the block back is a CodeMirror decoration, and two properties of
 * the editor decide the shape of this file:
 *
 *  - A decoration that covers line breaks may not be provided by a view plugin
 *    ("Decorations that replace line breaks may not be specified via plugins"),
 *    so the ranges live in a state field.
 *  - When two decorations cover exactly the same range, CodeMirror keeps the
 *    one it meets first and drops the other. So the block is drawn **once** —
 *    by whoever wins the range, never twice — and what wins is decided by the
 *    facet order, which follows extension precedence. Hence `Prec.highest`.
 *
 * The payoff is that the editor shows the same box the note shows, because both
 * come from `buildDiagramBox`.
 */

/** Forces every drawn block to be rebuilt, since the palette is baked into the SVG. */
const refreshEffect = StateEffect.define<null>();

/**
 * Bumped on a refresh. Widgets compare it, so a new token is what makes
 * CodeMirror throw the old DOM away instead of reusing a stale drawing.
 */
let token = 0;

/**
 * A block whose body starts with a keyword of ours. Cheap on purpose: the full
 * fence parse below it runs on every keystroke, and a note that contains no
 * mermaid fence at all should cost one scan for the word, not a parse.
 */
const MAYBE_OURS = /^[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid\b/m;

class DiagramWidget extends WidgetType {
  private box: BuiltDiagramBox | null = null;

  constructor(
    private readonly host: DiagramBlockHost,
    private readonly source: string,
    private readonly mode: DiagramMode,
    /** Opening fence line, 0-based, so the block can be located again on click. */
    private readonly startLine: number,
    /** Document position just inside the fence, where editing should resume. */
    private readonly bodyFrom: number,
    private readonly drawn: number
  ) {
    super();
  }

  eq(other: DiagramWidget): boolean {
    return (
      other.source === this.source &&
      other.mode === this.mode &&
      other.startLine === this.startLine &&
      other.drawn === this.drawn
    );
  }

  /** Roughly the box: a fixed-height canvas plus its chrome. */
  get estimatedHeight(): number {
    return 300;
  }

  toDOM(view: EditorView): HTMLElement {
    this.box = buildDiagramBox(this.host, this.source, this.mode, {
      onEdit: () => this.openEditor(view),
      onSource: () => revealSource(view, this.bodyFrom),
    });
    return this.box.el;
  }

  destroy(): void {
    this.box?.destroy();
    this.box = null;
  }

  /**
   * Opens the visual editor on this block.
   *
   * The occurrence index is counted here, against the document as it is right
   * now, rather than stored when the block was drawn: the user has been typing
   * in between, and an index from a minute ago would point at a different
   * fence. The write path re-checks the body anyway, so a stale index could
   * only ever be a hint in the right direction.
   */
  private openEditor(view: EditorView): void {
    const info = view.state.field(editorInfoField, false);
    const file = info?.file;
    if (!file) return;

    const siblings = siblingFences(view.state.doc.toString(), {
      lang: MERMAID_LANG,
      mode: this.mode,
    });
    const index = siblings.findIndex((fence) => fence.startLine === this.startLine);

    this.host.openEditor({
      target: {
        path: file.path,
        lang: MERMAID_LANG,
        mode: this.mode,
        index: index >= 0 ? index : null,
        body: this.source,
      },
      source: this.source,
      mode: this.mode,
    });
  }
}

/**
 * Hands the fenced block back to the plain editor.
 *
 * This replaces the source toggle the built-in embed carries: a replaced block
 * has no text left to put a cursor in, so the way back has to be explicit.
 */
function revealSource(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function touchesSelection(selection: EditorSelection, from: number, to: number): boolean {
  return selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function draw(state: EditorState, host: DiagramBlockHost): DecorationSet {
  // Source mode is plain text, and every fence should stay plain text there:
  // only Live Preview shows embeds.
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const text = state.doc.toString();
  if (!MAYBE_OURS.test(text)) return Decoration.none;

  const decorations: Range<Decoration>[] = [];
  for (const fence of listFences(text)) {
    if (fence.lang !== MERMAID_LANG) continue;
    const mode = detectMode(fence.body);
    // A mermaid kind we do not draw is mermaid's to keep.
    if (!mode) continue;
    if (fence.endLine + 1 > state.doc.lines) continue;

    const open = state.doc.line(fence.startLine + 1);
    const close = state.doc.line(fence.endLine + 1);
    // Seeing the source is the only way to edit it, so a block the cursor is
    // inside is never replaced.
    if (touchesSelection(state.selection, open.from, close.to)) continue;

    decorations.push(
      Decoration.replace({
        widget: new DiagramWidget(
          host,
          fence.body,
          mode,
          fence.startLine,
          Math.min(open.to + 1, close.from),
          token
        ),
        block: true,
      }).range(open.from, close.to)
    );
  }
  return Decoration.set(decorations, true);
}

function livePreviewField(host: DiagramBlockHost): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state) {
      return draw(state, host);
    },
    update(decorations, transaction) {
      const refresh = transaction.effects.some((effect) => effect.is(refreshEffect));
      if (refresh) token++;
      if (
        transaction.docChanged ||
        refresh ||
        transaction.selection ||
        // Toggling between source mode and Live Preview changes which of the
        // two this field should be doing at all.
        transaction.startState.field(editorLivePreviewField, false) !==
          transaction.state.field(editorLivePreviewField, false)
      ) {
        return draw(transaction.state, host);
      }
      return decorations.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/**
 * The plugin's Live Preview extension.
 *
 * `Prec.highest` is load-bearing rather than decoration: with two decorations
 * over one range, CodeMirror keeps the first it meets, and the order of the
 * decoration sets follows extension precedence. Without it the built-in renderer
 * wins the range and this file would be dead code that looks alive.
 */
export function livePreviewExtension(host: DiagramBlockHost): Extension {
  return Prec.highest(livePreviewField(host));
}

/**
 * Asks every open editor to draw its diagrams again, for the same reason the
 * reading view repaints: colours are attributes in the SVG, not CSS.
 */
export function refreshLivePreview(): void {
  token++;
  document.querySelectorAll(".cm-editor").forEach((el) => {
    EditorView.findFromDOM(el as HTMLElement)?.dispatch({ effects: refreshEffect.of(null) });
  });
}
