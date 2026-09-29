import { App, Modal, Notice, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { EditorPanel, type EditorPanelHost } from "./editor-panel";
import { ChartPanel } from "./chart-panel";
import { VIEW_TYPE_DIAGRAM } from "./view-type";
import { writeBlock, type BlockTarget } from "../block/block-target";
import { tagModalCloseButton } from "../utils/modal-fullscreen";
import { isCanvasMode, type DiagramMode } from "../core/model";

export interface SessionInit {
  target: BlockTarget;
  source: string;
  mode: DiagramMode;
  autoSave: boolean;
  /** Seconds between automatic writes while the block has unsaved changes. */
  autoSaveInterval: number;
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
  /**
   * Called after this session has written the panel's own text back.
   *
   * The panel cannot tell a write it started from one the session started — the
   * toolbar's save button and the auto-save clock both end up in the same
   * `writeBlock` — so the flag that says "there is something to save" has to be
   * cleared from the outside. Without it an auto-save would find the block dirty
   * for ever and rewrite the same text every interval.
   */
  markSaved(): void;
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
    // The fullscreen toggle now lives in the editor toolbar, not the corner;
    // the dialog only keeps the round close button styling.
    tagModalCloseButton(this.modalEl);
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

  /**
   * Auto-save state: the switch, the interval, and how far into it we are.
   *
   * A one-second tick rather than a timer armed for the whole interval. The
   * interval can be changed from the settings tab while this editor is open,
   * and a timer already counting down thirty seconds cannot be told about it;
   * counting seconds also keeps the promise the setting makes, that no more
   * than that many seconds of work is ever at risk.
   */
  private autoSaveOn: boolean;
  private autoSaveSeconds: number;
  private autoSaveElapsed = 0;
  private autoSaveTimer: number | null = null;
  /** A write is in flight. Ticks pass rather than queue up behind it. */
  private writing = false;
  /**
   * The "block is gone" message has already been shown for this failure run.
   *
   * The block can disappear while its editor is open — the note is beside the
   * panel in tab mode — and there is nothing to be done about it. Saying so once
   * is information; saying it every interval is a timer for bad news.
   */
  private blockMissingReported = false;

  constructor(app: App, registry: SessionRegistry, id: string, init: SessionInit) {
    this.app = app;
    this.registry = registry;
    this.id = id;
    this.target = init.target;
    this.autoSaveOn = init.autoSave;
    this.autoSaveSeconds = init.autoSaveInterval;
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
          host: this,
        })
      : new ChartPanel(document.createElement("div"), {
          source: init.source,
          mode: init.mode,
          host: this,
          app: this.app,
        });
    this.panel.root.remove();
  }

  start(): void {
    // Armed here rather than in the constructor: a session that was built and
    // never shown should not be ticking.
    this.autoSaveTimer = window.setInterval(() => void this.autoSaveTick(), 1000);
    // Always a dialog. A tab is still one press away — `expand` moves the panel
    // there — but which container an editor *opens* in was a vault-wide
    // preference that decided very little, and it made the first thing you see
    // depend on a setting two tabs away.
    this.openModal();
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
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    const modal = this.modal;
    this.modal = null;
    modal?.close();
    const leaf = this.leaf;
    this.leaf = null;
    leaf?.detach();
    /* With the switch on, "no need to press save" has to include this moment: a
       change made in the seconds before the dialog closes would otherwise sit
       inside an interval that never gets to elapse, which is the exact loss the
       setting was turned on to prevent. Read before `destroy`, which is what
       empties the panel. With the switch off nothing is written and the old
       contract stands. A write already in flight is left to finish rather than
       joined: it holds text from just before the newest change, so the two
       would fight over the same lines for the sake of a few milliseconds. */
    if (this.autoSaveOn && !this.writing && this.panel.hasChanges) {
      void this.save(this.panel.getSource(), true);
    }
    this.panel.destroy();
    this.registry.remove(this.id);
  }

  /* -------------------------------------------------------------- writing */

  /**
   * Writes `source` into the note, and marks the panel clean.
   *
   * `silent` is the auto-save path. A notice every interval would turn a
   * background guarantee into a stream of interruptions; the button still says
   * "saved" out loud for anyone who pressed it and wants the receipt.
   */
  async save(source: string, silent = false): Promise<void> {
    this.writing = true;
    try {
      const ok = await writeBlock(this.app, this.target, source);
      // The block moved or vanished. We say so rather than writing to a guess —
      // but only once per failure run, because the auto-save clock would
      // otherwise deliver the same bad news every interval.
      if (!ok) {
        if (!silent || !this.blockMissingReported) {
          new Notice(t("notice.blockMissing"));
        }
        this.blockMissingReported = true;
        return;
      }
      this.blockMissingReported = false;
      // Keep the locator pointing at what is now in the file, and let the panel
      // know there is nothing left to write. Cleared only on success, so a
      // failed write leaves the changes marked as unsaved rather than
      // forgetting about them.
      this.target.body = source;
      this.panel.markSaved();
      if (!silent) new Notice(t("notice.saved"));
    } finally {
      this.writing = false;
    }
  }

  /* ----------------------------------------------------------- auto-save */

  /**
   * Applies the auto-save settings to this editor, live.
   *
   * Read from the settings tab rather than once at construction: the tab can be
   * open beside a diagram, and a switch that only took effect on the *next*
   * editor would look broken on the one in front of the user. The clock restarts
   * when the interval itself moves, so the new number is counted from now rather
   * than from a count taken under the old one.
   */
  setAutoSave(enabled: boolean, interval: number): void {
    this.autoSaveOn = enabled;
    if (interval !== this.autoSaveSeconds) this.autoSaveElapsed = 0;
    this.autoSaveSeconds = interval;
  }

  /**
   * Adds a second to the clock, and writes when the interval is up.
   *
   * The count is dropped whenever the panel is clean, which is what makes the
   * interval mean "time since there was something to write" rather than "time
   * since the last write": a diagram left open and untouched is not rewritten
   * on a schedule. A write already in flight is left to land, and its tick is
   * spent — queueing a second write behind it would only race the first.
   */
  private async autoSaveTick(): Promise<void> {
    if (!this.autoSaveOn || this.writing) return;
    if (!this.panel.hasChanges) {
      this.autoSaveElapsed = 0;
      return;
    }
    this.autoSaveElapsed += 1;
    if (this.autoSaveElapsed < this.autoSaveSeconds) return;
    this.autoSaveElapsed = 0;
    await this.save(this.panel.getSource(), true);
  }

}
