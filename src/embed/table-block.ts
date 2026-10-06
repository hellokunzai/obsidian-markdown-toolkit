/**
 * A Markdown table with formulas in it, framed the way a diagram is framed —
 * reading view.
 *
 * The rule this file exists to keep: **the table is still a table.** Nothing
 * here introduces a syntax, a marker or a container — the note keeps an
 * ordinary Markdown table, the reader keeps the ability to open it in any other
 * editor, and the plugin's whole contribution is a frame drawn around what
 * Obsidian already rendered.
 *
 * Two consequences that shape the code:
 *
 * 1. **The source is read back out of the rendered DOM.** A post processor is
 *    handed elements, not text, so the model is rebuilt from the cells the
 *    renderer produced — which works precisely because a formula is plain cell
 *    text.
 * 2. **Only tables that actually compute something are touched.** A table with
 *    no formula in it is left exactly as Obsidian drew it, which is what keeps
 *    this from being a plugin that restyles every table you own.
 *
 * The frame, the corner buttons and the count badge are shared with the Live
 * Preview renderer — see `table-render.ts` for the part both need, and
 * `table-live-preview.ts` for the other caller.
 */
import {
  MarkdownRenderChild,
  TFile,
  type App,
  type MarkdownPostProcessorContext,
  type Plugin,
} from "obsidian";
import { h } from "../utils/dom";
import {
  evaluateTable,
  parseTable,
  replaceTableInText,
  serializeTable,
  type CellResult,
  type TableModel,
} from "../core/table-formula";
import { buildTableFrame, modelFromTable, shouldFrame, type TableFrame } from "./table-render";
import type { MarkdownEditorPlusSettings } from "../settings";

/** The slice of the plugin a table frame draws with. */
export interface TableBlockHost {
  readonly app: App;
  readonly settings: MarkdownEditorPlusSettings;
}

/** Every frame currently on screen, so a settings change can repaint them. */
const live = new Set<TableBlock>();

/**
 * Rebuilds every table frame that is on screen.
 *
 * Called when the render mode changes. The mode is read once, when a frame is
 * built, so without this a switch would only take effect somewhere else — and
 * the settings panel is usually open over the very note it is about.
 */
export function refreshTableBlocks(): void {
  for (const block of [...live]) block.rebuild();
}

/**
 * Registers the table post processor.
 *
 * No sort order is given, and that is deliberate: the elements this runs on are
 * produced by Obsidian's own Markdown renderer *before* post processing starts,
 * so there is nothing to race with. (The diagram processor does have to claim
 * its elements first, but that is because it is competing with another
 * processor rather than with the renderer.)
 */
export function registerTableBlocks(plugin: Plugin, host: TableBlockHost): void {
  plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const target = host.settings.tableTarget;
    for (const table of Array.from(el.querySelectorAll("table")).filter((node) => shouldFrame(node, target))) {
      const parent = table.parentElement;
      if (!parent) continue;

      /* The renderer's table is **adopted**, not merely preceded.
         Inserting the frame beside it and leaving the table where it was is
         what put two tables in the note at once: the painted one inside the
         frame, and the original still sitting under it. The frame has to
         contain the table for any of the three modes to mean anything — only
         then can "drawn" actually take the original off screen. */
      const frame = h("div", { cls: "mtk-embed-host" });
      parent.insertBefore(frame, table);
      frame.appendChild(table);

      ctx.addChild(new TableBlock(frame, host, table, ctx));
    }
  });
}

export class TableBlock extends MarkdownRenderChild {
  private readonly host: TableBlockHost;
  private readonly native: HTMLTableElement;
  private readonly ctx: MarkdownPostProcessorContext;

  private frame: TableFrame | null = null;
  private model: TableModel;
  private results: CellResult[][];
  /**
   * Set the moment the user starts an edit, so the one-shot alignment
   * correction below never clobbers an in-progress change.
   */
  private alignLocked = false;

  constructor(
    frameEl: HTMLElement,
    host: TableBlockHost,
    native: HTMLTableElement,
    ctx: MarkdownPostProcessorContext
  ) {
    super(frameEl);
    this.host = host;
    this.native = native;
    this.ctx = ctx;

    /* Read once. Every later rebuild works from this model rather than from the
       DOM, because the native render mode writes computed values *into* the
       cells — reading them back a second time would see the answers and lose
       the formulas that produced them. */
    this.model = modelFromTable(native);
    this.results = evaluateTable(this.model);
  }

  onload(): void {
    live.add(this);
    this.rebuild();
    /* Correct the column alignment once, from the note's Markdown separator.
       The model built in the constructor is read out of the rendered DOM, where
       `---` (default) and `:---` (left) have already collapsed into the same
       `text-align: left`, so a default text column is misread as left. That
       makes the editor's left/default toggle misfire. The separator row is the
       authoritative source; re-derive from it before the user can open the
       editor. Guarded so an in-progress edit is never clobbered. */
    void this.correctAlignFromSource();
  }

  onunload(): void {
    live.delete(this);
  }

  /**
   * Re-derives column alignment from the note's Markdown separator.
   *
   * The constructor reads the model out of the rendered DOM, where `---`
   * (default) and `:---` (left) have already collapsed into the same
   * `text-align: left` — so a default column is misread as left. The separator
   * row in the source is the only place the alignment still lives distinctly,
   * so read it there and patch the model. This is what lets the editor's align
   * toggle treat left and default as the separate states they are, instead of
   * flipping a default column to default when the user asks for left.
   *
   * Runs once at load only; `alignLocked` stops it from overwriting an edit the
   * user has already started.
   */
  private async correctAlignFromSource(): Promise<void> {
    if (this.alignLocked) return;
    const info = this.ctx.getSectionInfo(this.containerEl);
    const file = this.host.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!info || !(file instanceof TFile)) return;

    let text: string;
    try {
      text = await this.host.app.vault.cachedRead(file);
    } catch {
      return;
    }
    if (this.alignLocked) return;

    const section = text.split("\n").slice(info.lineStart, info.lineEnd + 1).join("\n");
    const parsed = parseTable(section);
    if (!parsed) return;
    if (parsed.align.length !== this.model.align.length) return;

    this.model = { ...this.model, align: parsed.align };
    /* Re-render now that the model holds the authoritative alignment. Without
       this the frame keeps the constructor's DOM-read alignment (where `---`
       and `:---` collapsed into "left"), so a default text column would still
       read as left and the editor's left/default toggle would misfire on it. */
    this.rebuild();
  }

  /** Draws the frame from the current model. Safe to call at any time. */
  rebuild(): void {
    /* Emptying the host detaches the renderer's table along with everything
       else. That is fine and intentional: the frame re-adopts it in the one mode
       that shows it, and the reference stays valid across the detach. */
    this.containerEl.empty();
    const source = this.host.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    const file = source instanceof TFile ? source : null;
    this.frame = buildTableFrame({
      model: this.model,
      results: this.results,
      mode: this.host.settings.tableRenderMode,
      native: this.native,
      app: this.host.app,
      file,
    });
    this.containerEl.appendChild(this.frame.el);
  }

  /**
   * Adopts an edited model and writes it back into the note.
   *
   * The write goes through the *section* the post processor was given, not the
   * whole file: a table sits in a note among other things, and rewriting the
   * file from what this block happens to know would delete all of it.
   */
  private async applyEdit(next: TableModel): Promise<void> {
    this.alignLocked = true;
    const markdown = serializeTable(next);
    const info = this.ctx.getSectionInfo(this.containerEl);
    const file = this.host.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!info || !(file instanceof TFile)) return;

    await this.host.app.vault.process(file, (text) => {
      const lines = text.split("\n");
      const section = lines.slice(info.lineStart, info.lineEnd + 1).join("\n");
      const replaced = replaceTableInText(section, markdown);
      if (replaced === null) return text;
      return [
        ...lines.slice(0, info.lineStart),
        ...replaced.split("\n"),
        ...lines.slice(info.lineEnd + 1),
      ].join("\n");
    });

    this.model = next;
    this.results = evaluateTable(next);
    this.rebuild();
  }
}
