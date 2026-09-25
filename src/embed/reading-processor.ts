import {
  MarkdownRenderChild,
  TFile,
  loadMermaid,
  type App,
  type MarkdownPostProcessorContext,
  type Plugin,
} from "obsidian";
import { t } from "../i18n";
import { detectKind, firstMeaningfulLine } from "../core/kinds";
import { MERMAID_LANG, type DiagramMode } from "../core/model";
import { siblingFences, type BlockTarget } from "../block/block-target";
import { buildDiagramBox, openLightbox, type BuiltDiagramBox, type DiagramBoxActions, type DiagramBoxHost } from "./box";
import { h } from "../utils/dom";

export interface OpenEditorRequest {
  target: BlockTarget;
  source: string;
  mode: DiagramMode;
}

/** Anything the plugin must re-draw when the theme changes. */
export interface Repaintable {
  repaint(): void;
}

/** What a rendered block needs from the plugin, so this module stays decoupled. */
export interface DiagramBlockHost extends DiagramBoxHost {
  openEditor(request: OpenEditorRequest): void;
  trackBlock(block: Repaintable): void;
  untrackBlock(block: Repaintable): void;
}

/**
 * Takes over the one fence language every mermaid diagram shares.
 *
 * Registering a processor for `mermaid` claims the language wholesale — there
 * is no way to handle some blocks and let the built-in renderer do the rest. So
 * the split happens inside the handler, on the body's first meaningful line:
 * every kind this plugin knows is drawn by us, and everything else — a
 * `quadrantChart`, an `xychart`, a diagram type newer than this plugin — is
 * handed to mermaid through the public `loadMermaid()`. Skipping that second
 * branch would turn every unrecognised mermaid block in the vault into plain
 * text the moment the plugin is enabled.
 *
 * This only reaches the reading view. In Live Preview the built-in renderer has
 * already turned the fenced block into an `<svg>` before plugin post processing
 * runs, so the editor side is claimed with a CodeMirror extension instead —
 * see `live-preview.ts`.
 */
export function registerDiagramBlocks(plugin: Plugin, host: DiagramBlockHost): void {
  plugin.registerMarkdownCodeBlockProcessor(
    MERMAID_LANG,
    (source, el, ctx) => {
      const kind = detectKind(source);
      if (kind) {
        ctx.addChild(new DiagramBlock(el, host, source, kind.mode, plugin.app, ctx));
        return;
      }
      // `kind` stays null for a mermaid type we have never heard of, which is
      // also worth knowing: it is what turns a blank block into "this looks
      // like a `quadrantChart`, not a broken diagram".
      ctx.addChild(new MermaidPassThrough(el, source));
    },
    // Post processors run in sort order, and this one has to be first.
    //
    // A code block processor is handed `code.language-mermaid` elements.
    // Obsidian's own mermaid renderer consumes exactly the same elements, so if
    // it ran first it would have already swapped them for an <svg> and this
    // handler would never fire on anything — the plugin would look installed
    // and do nothing at all. Claiming the elements first is also what stops a
    // run-through block from being drawn twice.
    -100
  );
}

/* ------------------------------------------------------------------ ours */

/**
 * A diagram rendered in place in the note.
 *
 * Read-only: the block draws the diagram and offers exactly one way in — the
 * entry button, which only appears on hover so the document is not peppered
 * with controls.
 *
 * The drawing itself lives in `box.ts`, shared with the editor extension, so
 * the note and the editor cannot drift apart about how a diagram looks.
 *
 * `MarkdownRenderChild` carries only `containerEl`, so `app` and the
 * post-processor context (needed to resolve which fenced block this element is)
 * are handed in explicitly.
 */
export class DiagramBlock extends MarkdownRenderChild {
  private readonly host: DiagramBlockHost;
  private readonly source: string;
  private readonly mode: DiagramMode;
  private readonly ownerApp: App;
  private readonly ctx: MarkdownPostProcessorContext;
  private box: BuiltDiagramBox | null = null;
  private entryRAF: number | null = null;

  constructor(
    containerEl: HTMLElement,
    host: DiagramBlockHost,
    source: string,
    mode: DiagramMode,
    app: App,
    ctx: MarkdownPostProcessorContext
  ) {
    super(containerEl);
    this.host = host;
    this.source = source;
    this.mode = mode;
    this.ownerApp = app;
    this.ctx = ctx;
    this.containerEl.classList.add("mtk-embed-host");
  }

  onload(): void {
    this.host.trackBlock(this);
    this.render();
  }

  onunload(): void {
    this.host.untrackBlock(this);
    this.teardown();
  }

  /** Called on theme change: SVG paints are attributes, not consumable CSS. */
  repaint(): void {
    this.render();
  }

  private teardown(): void {
    this.box?.destroy();
    this.box = null;
    if (this.entryRAF !== null) {
      cancelAnimationFrame(this.entryRAF);
      this.entryRAF = null;
    }
  }

  private render(): void {
    this.teardown();
    this.containerEl.replaceChildren();

    // Which entry points this block carries depends on where it is drawn. The
    // element may not be attached to the document yet when we get here — an
    // embed mounted by the editor is placed a frame or two later — and
    // `closest()` cannot answer before that, so asking early is how the editor
    // ended up being read as the reading view and getting no edit entry at all.
    if (this.containerEl.isConnected) {
      this.mount(this.drawsSourceEntry());
      return;
    }
    let frames = 0;
    const tick = (): void => {
      if (this.entryRAF === null) return; // torn down while waiting
      if (this.containerEl.isConnected) {
        this.entryRAF = null;
        this.mount(this.drawsSourceEntry());
        return;
      }
      if (++frames > 60) {
        this.entryRAF = null;
        this.mount(false);
        return;
      }
      this.entryRAF = requestAnimationFrame(tick);
    };
    this.entryRAF = requestAnimationFrame(tick);
  }

  private mount(inSource: boolean): void {
    const actions: DiagramBoxActions = inSource
      ? { onEdit: () => void this.requestEdit() }
      : { onView: () => openLightbox(this.host, this.source, this.mode) };
    this.box = buildDiagramBox(this.host, this.source, this.mode, actions);
    this.containerEl.appendChild(this.box.el);
  }

  private drawsSourceEntry(): boolean {
    return Boolean(this.containerEl.closest(".cm-editor, .markdown-source-view"));
  }

  /**
   * Works out which fenced block this element is, then asks the plugin to open
   * the editor. The occurrence index is a hint, not a promise: the reader may
   * have edited the lines above since this was rendered, so the write path
   * re-checks the body before touching anything.
   */
  private async requestEdit(): Promise<void> {
    const file = await this.resolveFile();
    if (!file) return;

    let index: number | null = null;
    const info = this.ctx.getSectionInfo(this.containerEl);
    if (info) {
      const text = await this.ownerApp.vault.cachedRead(file);
      // Counted among our own kind only: every mermaid block in the note shares
      // the language, so a plain language count would not match the list the
      // write path builds.
      const fences = siblingFences(text, { lang: MERMAID_LANG, mode: this.mode });
      const before = fences.filter((fence) => fence.startLine < info.lineStart).length;
      index = before < fences.length ? before : null;
    }

    this.host.openEditor({
      target: { path: file.path, lang: MERMAID_LANG, mode: this.mode, index, body: this.source },
      source: this.source,
      mode: this.mode,
    });
  }

  private async resolveFile(): Promise<TFile | null> {
    const path = this.ctx.sourcePath;
    if (path) {
      const file = this.ownerApp.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
    }
    return this.ownerApp.workspace.getActiveFile();
  }
}

/* --------------------------------------------------------------- not ours */

let mermaidSequence = 0;

/**
 * A mermaid block we do not model — a `quadrantChart`, an `xychart`, a diagram
 * type mermaid has that this plugin never learned — rendered the way Obsidian
 * would have rendered it.
 *
 * This used to be the fate of ten of the eleven kinds. It is now only reached
 * by a keyword outside `DIAGRAM_KINDS`, which has a useful side effect worth
 * naming: our own eleven are drawn by our own code, so none of them depends on
 * which version of mermaid the running Obsidian happens to bundle. A fishbone
 * diagram no longer turns into a stack of source lines on an older client.
 *
 * Drawing the rest properly is the only honest option — the alternative to
 * "show it" is "hide it".
 *
 * The failure message names the keyword rather than the kind, because the
 * keyword is the most specific thing known about a block we do not model.
 */
export class MermaidPassThrough extends MarkdownRenderChild {
  private readonly source: string;
  private alive = true;

  constructor(containerEl: HTMLElement, source: string) {
    super(containerEl);
    this.source = source;
    this.containerEl.classList.add("mtk-embed-host", "mtk-embed-mermaid");
  }

  onload(): void {
    void this.draw();
  }

  onunload(): void {
    // `render` is async and the block can be torn down while it is in flight.
    this.alive = false;
  }

  repaint(): void {
    void this.draw();
  }

  private async draw(): Promise<void> {
    const id = `mtk-mermaid-${++mermaidSequence}`;
    let svgText = "";
    try {
      const mermaid = await loadMermaid();
      const result = await mermaid.render(id, this.source);
      svgText = typeof result === "string" ? result : String(result?.svg ?? "");
      if (!svgText) throw new Error("mermaid returned no svg");
    } catch (error) {
      console.error("MarkdownEditorPlus: mermaid could not render an unowned block", error);
      this.sweep(id);
      if (this.alive) this.showSource(t("embed.renderFailed", { kind: this.kindLabel() }));
      return;
    }
    if (!this.alive) return;

    const svg = this.parseSvg(svgText);
    this.containerEl.replaceChildren();
    if (svg) this.containerEl.appendChild(svg);
    else this.showSource(t("embed.renderFailed", { kind: this.kindLabel() }));
  }

  /** The diagram type's keyword, for a failure message worth reading. */
  private kindLabel(): string {
    return firstMeaningfulLine(this.source).split(/\s+/)[0] || t("embed.unknownKind");
  }

  /**
   * Parses a mermaid SVG string into a live element without ever touching
   * `innerHTML` — the whole plugin holds that line, and an SVG string coming
   * back from a renderer is no reason to cross it. The mime type matters:
   * `text/html` would parse the fragment as HTML and lose the SVG namespace.
   */
  private parseSvg(svgText: string): Element | null {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName === "parsererror") return null;
    return document.importNode(root, true);
  }

  /**
   * mermaid leaves the scratch element it renders into behind when it throws.
   * Naming differs between versions, so both candidate ids are checked.
   */
  private sweep(id: string): void {
    for (const candidate of [id, `d${id}`]) {
      document.getElementById(candidate)?.remove();
    }
  }

  /** Text that cannot be drawn stays visible and selectable, never swallowed. */
  private showSource(note: string): void {
    this.containerEl.replaceChildren();
    this.containerEl.appendChild(h("div", { cls: "mtk-embed-message", text: note }));
    const pre = h("pre", { cls: "mtk-embed-pre" });
    pre.textContent = this.source;
    this.containerEl.appendChild(pre);
  }
}
