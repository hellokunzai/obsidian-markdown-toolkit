import { App, Modal, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { EditorPanel, type EditorPanelHost } from "./editor-panel";
import { ChartPanel } from "./chart-panel";
import { VIEW_TYPE_DIAGRAM } from "./view-type";
import { rasterizeSvg } from "../render/export";
import { writeBlock, type BlockTarget } from "../block/block-target";
import { isCanvasMode, type DiagramMode, type FlowDirection, type MindmapLayout } from "../core/model";

export interface SessionInit {
  target: BlockTarget;
  source: string;
  mode: DiagramMode;
  persistPositions: boolean;
  mindmapLayout: MindmapLayout;
  flowDirection: FlowDirection;
  openIn: "modal" | "tab";
}

export interface SessionRegistry {
  find(id: string): EditorSession | null;
  remove(id: string): void;
}

/**
 * What a session needs from whichever editor it is hosting.
 *
 * The session moves its panel between a dialog and a tab, so it has to be able
 * to re-parent it, tear it down, read the text back out and repaint it. It has
 * no business knowing which of the two panels it holds — the node-and-edge
 * editor and the chart canvas are interchangeable from here.
 */
export interface SessionPanel {
  readonly root: HTMLElement;
  attach(host: HTMLElement): void;
  destroy(): void;
  getSource(): string;
  readonly hasChanges: boolean;
  repaintForTheme(): void;
}

/** Dialog shell. It only ever hosts the session's panel — it owns no state. */
class DiagramModal extends Modal {
  private readonly session: EditorSession;

  constructor(app: App, session: EditorSession) {
    super(app);
    this.session = session;
  }

  onOpen(): void {
    // Sized on the shell element rather than via `:has()`, which older Electron
    // builds used by some app versions do not support.
    this.modalEl.classList.add("mtk-modal-shell");
    this.contentEl.classList.add("mtk-modal", "mtk-in-dialog");
    this.session.attachPanel(this.contentEl, false);
  }

  onClose(): void {
    this.session.onModalClosed();
  }
}

/**
 * One editing session: the panel plus whichever container currently shows it.
 *
 * The panel is created once and *moved* between containers, so promoting a
 * dialog to a tab keeps the model, the viewport, the selection and the whole
 * undo stack — and there is only ever one editor implementation to maintain.
 */
export class EditorSession implements EditorPanelHost {
  readonly id: string;
  readonly panel: SessionPanel;
  where: "modal" | "tab" | "closed" = "closed";

  private readonly app: App;
  private readonly registry: SessionRegistry;
  private readonly target: BlockTarget;
  private modal: DiagramModal | null = null;
  private leaf: WorkspaceLeaf | null = null;
  private finishing = false;

  constructor(app: App, registry: SessionRegistry, id: string, init: SessionInit) {
    this.app = app;
    this.registry = registry;
    this.id = id;
    this.target = init.target;
    // The one place the two editor families meet. A mind map and a flowchart
    // are boxes joined by lines; the other nine are columns, sectors, bars and
    // swimlanes, and no amount of shared plumbing makes one canvas fit both.
    // Everything downstream — moving between containers, saving, exporting —
    // is written against `SessionPanel` and does not care which it got.
    this.panel = isCanvasMode(init.mode)
      ? new EditorPanel(document.createElement("div"), {
          source: init.source,
          mode: init.mode,
          // The badge names the diagram kind, not the fence language: every
          // block is ```mermaid now, so showing that would say nothing.
          modeLabel: init.mode === "mindmap" ? "mindmap" : "flowchart",
          persistPositions: init.persistPositions,
          mindmapLayout: init.mindmapLayout,
          flowDirection: init.flowDirection,
          host: this,
        })
      : new ChartPanel(document.createElement("div"), {
          source: init.source,
          mode: init.mode,
          host: this,
        });
    this.panel.root.remove();
    this.startIn = init.openIn;
  }

  private readonly startIn: "modal" | "tab";

  start(): void {
    if (this.startIn === "tab") void this.openTab();
    else this.openModal();
  }

  /* ----------------------------------------------------------- containers */

  attachPanel(host: HTMLElement, inTab: boolean): void {
    host.classList.toggle("mtk-in-tab", inTab);
    this.panel.attach(host);
  }

  private openModal(): void {
    this.where = "modal";
    const modal = new DiagramModal(this.app, this);
    this.modal = modal;
    modal.open();
  }

  private async openTab(): Promise<void> {
    this.where = "tab";
    const leaf = this.app.workspace.getLeaf("tab");
    this.leaf = leaf;
    await leaf.setViewState({
      type: VIEW_TYPE_DIAGRAM,
      active: true,
      state: { sessionId: this.id },
    });
  }

  // EditorPanelHost ----------------------------------------------------------

  expand(): void {
    if (this.where === "tab") return;
    this.where = "tab";
    void this.openTab();
    // Closing the dialog here is safe: onModalClosed sees `where === "tab"` and
    // leaves the panel alive for the tab to adopt.
    this.modal?.close();
    this.modal = null;
  }

  collapse(): void {
    if (this.where !== "tab") return;
    this.where = "modal";
    this.openModal();
    const leaf = this.leaf;
    this.leaf = null;
    leaf?.detach();
  }

  /** Called by the dialog shell whenever it closes, however it was closed. */
  onModalClosed(): void {
    this.modal = null;
    if (this.where === "tab") return;
    this.finish();
  }

  close(): void {
    this.finish();
  }

  finish(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.where = "closed";
    const modal = this.modal;
    this.modal = null;
    modal?.close();
    const leaf = this.leaf;
    this.leaf = null;
    leaf?.detach();
    this.panel.destroy();
    this.registry.remove(this.id);
  }

  /* -------------------------------------------------------------- writing */

  async save(source: string): Promise<void> {
    const ok = await writeBlock(this.app, this.target, source);
    // The block moved or vanished. We say so rather than writing to a guess.
    if (!ok) {
      new Notice(t("notice.blockMissing"));
      return;
    }
    // Keep the locator pointing at what is now in the file.
    this.target.body = source;
    new Notice(t("notice.saved"));
  }

  async exportFile(kind: "svg" | "png", svg: string, width: number, height: number): Promise<void> {
    const note = this.app.vault.getAbstractFileByPath(this.target.path);
    const folder = note instanceof TFile ? note.parent?.path ?? "" : "";
    const base = note instanceof TFile ? note.basename : "diagram";
    const join = (name: string): string => (folder ? `${folder}/${name}` : name);

    let path = join(`${base}.${kind}`);
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = join(`${base} ${counter}.${kind}`);
      counter += 1;
    }

    try {
      if (kind === "svg") await this.app.vault.create(path, svg);
      else await this.app.vault.createBinary(path, await rasterizeSvg(svg, width, height, 2));
      new Notice(t("notice.exported", { name: path }));
    } catch (error) {
      console.error("MarkdownEditorPlus: export failed", error);
      new Notice(t("notice.exportFailed"));
    }
  }
}
