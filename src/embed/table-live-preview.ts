/**
 * Framing computed tables inside the Live Preview editor.
 *
 * Why this is a separate mechanism from the reading view, and why it is not a
 * decoration:
 *
 * Obsidian hands plugin post processors finished elements in the reading view.
 * In the editor there are no such elements to claim — CodeMirror owns that DOM
 * and rebuilds it whenever it likes — so a table cannot be *given* to us, it has
 * to be found. A CodeMirror decoration would be the other way to do it, and it
 * is the wrong one here: replacing a line range with a widget takes the table
 * out of the document's editing surface, and a table is the one Markdown
 * construct people actually type into.
 *
 * So this walks the editor's DOM, and it is careful about exactly one thing:
 * **it never touches a table the caret is in.** A table with the cursor inside
 * is left completely alone — unframed, unmodified, still the renderer's own —
 * because that is the table the user is editing. Everything else follows from
 * that rule: the frame appears when you look at a table and gets out of the way
 * when you go to change it.
 *
 * ## Two things this must not do
 *
 * Both were tried and both were wrong:
 *
 * 1. **It must not hide or move an element CodeMirror owns.** Nesting the frame
 *    at `.cm-content` level and setting `display: none` on the editor's own
 *    element for the block looked like the tidy way to make the frame full
 *    width. It breaks CodeMirror's invariants instead: the editor re-renders the
 *    block, a fresh table appears, that one gets framed too, and the note fills
 *    up with copies. The renderer's own elements are left exactly where
 *    CodeMirror put them; only their *children* are touched.
 * 2. **It must not ask for a percentage width.** The element the renderer puts a
 *    table in is sized to its contents, so `width: 100%` inside it resolves
 *    against a width that the frame itself is deciding — the frame ends up
 *    hugging the table, which is why the editor's version looked nothing like
 *    the reading view's. The width is *measured* from the editor's content
 *    column and set in pixels, which breaks the circularity.
 *
 * The caret test is by **document line range**, not by DOM containment: in
 * drawn mode the renderer's table is out of the DOM, so a containment test would
 * leave the frame standing over a table the user had just clicked into.
 */
import { type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { h } from "../utils/dom";
import {
  evaluateTable,
  parseTable,
  serializeTable,
  type CellResult,
  type TableModel,
} from "../core/table-formula";
import { buildTableFrame, modelFromTable, shouldFrame, type TableFrame } from "./table-render";
import { openTableEditor } from "../editor/table-panel";
import type { TableBlockHost } from "./table-block";

/** Where a table's own Markdown lives in the document. */
interface TableRange {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
}

/** A table this plugin has framed, and what it was framed from. */
interface Framed {
  table: HTMLTableElement;
  host: HTMLElement;
  frame: TableFrame;
  range: TableRange;
  /**
   * The renderer's widget block around this table, if there was one.
   *
   * Obsidian hangs its own add-row / add-col buttons inside the block's
   * `.table-wrapper`, right beside the table. While the table is framed they
   * would keep floating around a table that is no longer the editor's — the
   * strip below and the "+" column on the right of a framed table. The block
   * is marked for as long as the frame stands so the stylesheet can hide them,
   * and the element is kept here because in drawn mode the table itself is
   * detached and `closest()` can no longer find its way back to the block.
   */
  widget: HTMLElement | null;
}

export function tableLivePreviewExtension(host: TableBlockHost): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly framed = new Map<HTMLTableElement, Framed>();
      private readonly resize: ResizeObserver;
      private scheduled: number | null = null;

      constructor(view: EditorView) {
        this.view = view;
        /* The editor's column changes width when a sidebar opens or the pane is
           dragged, and a frame sized in pixels has to follow it — a fixed width
           would leave the frame hanging past the text, or short of it. */
        this.resize = new ResizeObserver(() => this.applyWidths());
        this.resize.observe(view.contentDOM);
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return;
        /* A document change invalidates every range we hold, and in native mode
           the models cannot be re-read to recover one — the cells hold answers
           by then. Dropping the frames and letting the next pass rebuild them
           from fresh cells is both simpler and the only correct option. */
        if (update.docChanged) this.unframeAll();
        this.schedule();
      }

      destroy(): void {
        this.resize.disconnect();
        if (this.scheduled !== null) window.cancelAnimationFrame(this.scheduled);
        this.unframeAll();
      }

      /**
       * One sync per frame, never inside an update.
       *
       * The sync moves elements around, and CodeMirror measures during an
       * update; mutating the DOM underneath it there is how a plugin makes an
       * editor's scroll position jump.
       */
      private schedule(): void {
        if (this.scheduled !== null) return;
        this.scheduled = window.requestAnimationFrame(() => {
          this.scheduled = null;
          this.sync();
        });
      }

      private sync(): void {
        if (!this.view.state.field(editorLivePreviewField, false)) {
          // Source mode: the note is its own Markdown there, which is exactly
          // the text the user is editing. Nothing to frame.
          this.unframeAll();
          return;
        }

        /* Frames CodeMirror has thrown away along with the DOM it rebuilt them
           in. The test is on the *holder*, not on the table: in drawn mode the
           renderer's table is legitimately detached, so asking whether it is
           connected would drop every healthy frame. */
        for (const entry of [...this.framed.values()]) {
          if (!this.view.dom.contains(entry.host)) this.framed.delete(entry.table);
        }

        /* The one rule. Checked for *every* framed table, including the ones
           whose native element is detached — a table being read and a table
           being typed into are told apart by where the caret is in the
           document, which is the only place the answer is reliable. */
        for (const entry of [...this.framed.values()]) {
          if (this.selectionTouches(entry.range)) this.unframe(entry);
        }

        for (const node of Array.from(this.view.dom.querySelectorAll("table"))) {
          const table = node as HTMLTableElement;
          /* A painted table lives inside a frame and would otherwise be a
             candidate for framing itself. It holds no formulas, so it would be
             skipped anyway — but relying on that is one cell of `#REF!` away
             from recursive frames. */
          if (table.closest(".mtk-embed") !== null) continue;
          if (this.framed.has(table)) continue;
          if (!shouldFrame(table, host.settings.tableTarget)) continue;

          const range = this.locate(table);
          if (!range || this.selectionTouches(range)) continue;
          this.frame(table, range);
        }

        this.applyWidths();
      }

      /** True when any selection range has its caret on one of the table's lines. */
      private selectionTouches(range: TableRange): boolean {
        const doc = this.view.state.doc;
        return this.view.state.selection.ranges.some((r) => {
          const line = doc.lineAt(r.head).number;
          return line >= range.startLine && line <= range.endLine;
        });
      }

      /** The lines the table occupies, read while its element is still placed. */
      private locate(table: HTMLTableElement): TableRange | null {
        try {
          const doc = this.view.state.doc;
          const startLine = doc.lineAt(this.view.posAtDOM(table)).number;
          let endLine = startLine;
          while (endLine < doc.lines && doc.line(endLine + 1).text.trim().startsWith("|")) {
            endLine += 1;
          }
          return {
            from: doc.line(startLine).from,
            to: doc.line(endLine).to,
            startLine,
            endLine,
          };
        } catch {
          // `posAtDOM` throws for a node CodeMirror does not consider part of
          // the document. That means this is not a table we can write back to,
          // so the honest answer is to leave it alone.
          return null;
        }
      }

      /** The width of the editor's text column, in pixels. */
      private columnWidth(): number {
        const content = this.view.contentDOM;
        const style = window.getComputedStyle(content);
        const padding =
          (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
        return Math.max(0, Math.round(content.clientWidth - padding));
      }

      private applyWidths(): void {
        const width = this.columnWidth();
        if (width <= 0) return;
        for (const entry of this.framed.values()) entry.host.style.width = `${width}px`;
      }

      private frame(table: HTMLTableElement, range: TableRange): void {
        const parent = table.parentElement;
        if (!parent) return;

        // Read before moving anything: both the model and the range are
        // answered by position, and position is the first thing a move destroys.
        /* The alignment row is the only place the separator survives once the
           table is rendered: the DOM resolves `:---` / `:---:` / `---:` into a
           per-cell `text-align`, where `---` (default) and `:---` (left) both
           compute to `left` and can no longer be told apart. Read the alignment
           back from the Markdown source so an explicit left stays left and a
           default stays default — otherwise the editor's align toggle, which
           flips left <-> default, misfires on text columns. */
        const source = this.view.state.doc.sliceString(range.from, range.to);
        const sourceAlign = parseTable(source)?.align;
        const model = modelFromTable(table, sourceAlign);
        const results: CellResult[][] = evaluateTable(model);

        /* The renderer's widget block, marked before the table is adopted so
           the stylesheet can retire the block's own add-row / add-col buttons
           for as long as the frame stands. */
        const widget = table.closest(".cm-table-widget");
        if (widget) widget.classList.add("mtk-table-framed");

        const holder = h("div", { cls: "mtk-embed-host" });
        parent.insertBefore(holder, table);
        /* Taken out of the flow rather than left as a sibling of the frame.
           A sibling is what put two tables on screen at once: the frame's own
           table, and the renderer's still sitting beside it. The frame adopts it
           back in the one mode that shows it. */
        table.remove();

        const frame = buildTableFrame({
          model,
          results,
          mode: host.settings.tableRenderMode,
          native: table,
          app: host.app,
          file: host.app.workspace.getActiveFile(),
          editable: true,
          onEdit: () => {
            openTableEditor({
              app: host.app,
              model,
              fillMode: host.settings.tableFillMode,
              onSave: (next) => {
                this.view.dispatch({
                  changes: { from: range.from, to: range.to, insert: serializeTable(next) },
                });
              },
            });
          },
        });
        holder.appendChild(frame.el);

        const width = this.columnWidth();
        if (width > 0) holder.style.width = `${width}px`;
        this.framed.set(table, { table, host: holder, frame, range, widget: widget as HTMLElement | null });
      }

      private unframe(entry: Framed): void {
        // Undo first: in native mode the cells hold answers, and the renderer's
        // table is about to become the editor again.
        entry.frame.restore();
        const parent = entry.host.parentElement;
        if (parent) parent.insertBefore(entry.table, entry.host);
        entry.host.remove();
        /* The block's own buttons come back with its table — the native
           interactions belong to a table the user is about to type into. */
        if (entry.widget) entry.widget.classList.remove("mtk-table-framed");
        this.framed.delete(entry.table);
      }

      private unframeAll(): void {
        for (const entry of [...this.framed.values()]) this.unframe(entry);
      }
    }
  );
}
