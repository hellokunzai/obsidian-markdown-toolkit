import {
  PluginSettingTab,
  Setting,
  App,
  Modal,
  FuzzySuggestModal,
  Notice,
  TFolder,
  getIconIds,
  setIcon,
  type Command,
  type SliderComponent,
} from "obsidian";
import { t } from "./i18n";
import { h } from "./utils/dom";
import { applyTooltip } from "./utils/tooltip";import { commandName } from "./utils/commands";
import { DIAGRAM_KINDS } from "./core/kinds";
import {
  defaultToolbarCommands,
  isGroupLabel,
  isSubmenu,
  type ToolbarCommand,
} from "./core/toolbar-commands";
import {
  TOOLBAR_BACKGROUND_DEFAULT,
  TOOLBAR_BACKGROUND_TRANSPARENT,
} from "./core/toolbar-background";
import type { EmptyFolderHandling } from "./features/attachment-paths";
import { resolveDuplicateSeparator, stripExtension } from "./features/attachment-paths";
import type { Orders } from "./features/order-store";
import { childPath, ROOT_KEY } from "./features/order-store";
import { closeColorPicker } from "./ui/color-picker";
import type MarkdownEditorPlusPlugin from "./main";

/**
 * There is deliberately no block-language setting here.
 *
 * Every diagram is a ```mermaid fence and the kind is declared inside the body,
 * so the fence language is a spec detail rather than a preference. Offering it
 * as a text box only created ways to break notes: a rename could not take
 * effect without a reload (a code block processor cannot be unregistered), and
 * two names could collide. What used to be two text fields is now one honest
 * fact about the format.
 */
export type { ToolbarCommand };

/**
 * Bounds on the auto-save interval, in seconds.
 *
 * A floor rather than a free number: below a few seconds most edits would be
 * written mid-gesture, turning every drag into a burst of file writes for no
 * gain over doing nothing at all.
 */
export const MIN_AUTO_SAVE_SECONDS = 5;
export const MAX_AUTO_SAVE_SECONDS = 300;
const AUTO_SAVE_STEP = 5;

export interface MarkdownEditorPlusSettings {
  /* Four rows left this tab, along with the options behind them: the flowchart's
     default direction, a mind map's growth direction, whether dragged positions
     are remembered, and where the editor opens. Each has one answer now, held
     by the code that uses it — `DEFAULT_FLOW_DIRECTION`, `layoutMindmap`,
     `serializeDiagram`, the dialog — rather than by a preference. A `data.json`
     still carrying the old keys drops them on the next save. */
  /**
   * Whether an open editor writes its own changes back as it goes.
   *
   * A save button answers "did I remember to press it"; this answers it before
   * the question comes up. Only a real change triggers a write — opening a
   * diagram and looking at it never touches the file.
   */
  autoSave: boolean;
  /**
   * Seconds between those writes, counted from the moment the block went dirty.
   *
   * This is the *ceiling* on what a crash can cost, which is why it is a number
   * the user picks rather than a constant: a throwaway sketch and a diagram
   * that took an hour to lay out deserve different answers.
   */
  autoSaveInterval: number;

  // ---- New editor-explorer features (0.4.0) ----
  /** Commands shown in the editor toolbar, in display order. */
  toolbarCommands: ToolbarCommand[];
  /**
   * The colour the editor toolbar paints behind those commands.
   *
   * A validated CSS colour (`#rgb[g]/rgb()/hsl()/var(--…)`/`transparent`) or
   * `""`, which is the default and means "leave it to the theme". See
   * `core/toolbar-background.ts` for why this is a string and not a colour.
   */
  editorToolbarBackground: string;
  /**
   * Entry names to hide in the file explorer, one per line: an exact name, a
   * `startsWith::PREFIX`, or an `endsWith::SUFFIX`.
   */
  hiddenRules: string;
  /** Whether the rules above are applied at all. */
  hiddenEnabled: boolean;
  /** Match rule names without regard to case. */
  hiddenIgnoreCase: boolean;
  /** Mirror the hidden entries into Obsidian's own excluded-files list. */
  hiddenExcludeList: boolean;
  /** Hide the status-bar indicator that reports how many entries are hidden. */
  hiddenStatusBar: boolean;
  /**
   * Whether the eye toggle button is put in the left ribbon.
   *
   * It governs the *button*, not the hiding: with it off the rules keep
   * applying and the switches here stay in charge, only the one-click toggle
   * goes away.
   */
  hiddenRibbonButton: boolean;
  /**
   * The exact strings this plugin last wrote into the excluded-files list.
   *
   * Kept so they can be removed again precisely: re-deriving them from the rules
   * would miss anything the user has deleted since, and those entries would
   * linger in Obsidian's list with nothing left to point at them.
   */
  hiddenExcludeEntries: string[];
  /**
   * Whether the reorder button is put in the file explorer's toolbar.
   *
   * It governs the *button*, not the order. With it off the tree keeps the
   * arrangement it was given — only the ability to change that arrangement goes
   * away, which is why the sorting patch outlives this flag rather than being
   * taken back out with it. See `features/file-order.ts`.
   */
  orderButton: boolean;
  /**
   * Whether the button has been pressed — the mode, not the switch.
   *
   * Remembered across restarts, so a vault left in arrange mode comes back in
   * it instead of silently dropping the handles half way through. Only ever
   * true while `orderButton` is on: hiding the button clears this, because a
   * mode with nothing to press it with cannot be left or explained.
   */
  orderMode: boolean;
  /**
   * Per-folder custom order: folder path -> the names of the subfolders in it,
   * in the order they are to be drawn. Subfolders only — notes are left to the
   * sort menu. See `features/order-store.ts`.
   */
  orderMap: Orders;
  /** Template for generated attachment file names. */
  attachmentTemplate: string;
  /** Token-aware folder template for where new attachments are saved. */
  attachmentFolder: string;
  /** Characters to replace (or delete) in generated attachment folder/file names. */
  attachmentSpecialChars: string;
  /** String substituted for each special character; empty deletes them instead. */
  attachmentSpecialCharsReplacement: string;
  /** When a note is renamed, keep its attachment folder in sync. */
  syncAttachmentsOnRename: boolean;
  /** When a note is moved to another folder, keep its attachment folder in sync. */
  syncAttachmentsOnMove: boolean;
  /** Inserted before the counter when a generated attachment name is taken. */
  attachmentDuplicateSeparator: string;
  /** What happens to a note's attachment folder once it has become empty. */
  emptyFolderHandling: EmptyFolderHandling;
  /** Delete a deleted note's now-unreferenced attachments automatically. */
  deleteOrphanedOnNoteDelete: boolean;

  // ---- Table formulas (0.20.0) ----
  /** Whether the table editor writes its own changes back on a timer. */
  tableAutoSave: boolean;
  /** Seconds between table auto-saves, counted from the moment the table went dirty. */
  tableAutoSaveInterval: number;
  /** Whether computed cells get the `ƒ` marker and tint in every table context. */
  tableHighlightFormulas: boolean;

  // ---- 功能总开关（0.21.0）----
  /**
   * Master switches for each major module, set from the 功能 tab.
   *
   * A module that is off has its settings tab hidden in the settings panel and
   * its feature disabled in the editor — both at once, so turning something off
   * is one decision rather than two. The 功能 tab itself is always present and
   * cannot be switched off. See `main.ts` `applyFeatureToggles`.
   */
  features: {
    /** Editor toolbar: the command bar pinned above Markdown editors. */
    toolbar: boolean;
    /** Table editor: framed tables with formula support. */
    table: boolean;
    /** Diagram editor: mermaid rendering and its visual editor. */
    diagram: boolean;
    /** Attachment handling: custom folder, plus rename/move and orphan sync. */
    attachment: boolean;
    /** File hiding in the explorer. */
    hiding: boolean;
    /** Manual file ordering in the explorer. */
    order: boolean;
  };
}

/** The six modules the 功能 tab switches on or off. */
export type FeatureKey = "toolbar" | "table" | "diagram" | "attachment" | "hiding" | "order";

export const DEFAULT_SETTINGS: MarkdownEditorPlusSettings = {
  // On by default: autosave only ever writes back what the user typed into
  // the diagram editor itself — it does not invent content, and the manual
  // save button stays available. One click turns it off for anyone who
  // prefers explicit saves.
  autoSave: true,
  autoSaveInterval: 30,

  // Ported from the reference plugin's own default list; see
  // `core/toolbar-commands.ts` for what carried over and what did not.
  toolbarCommands: defaultToolbarCommands(),
  // The theme's own colour, said as "no override": the bar keeps the
  // `--background-secondary` it has always been painted with.
  editorToolbarBackground: TOOLBAR_BACKGROUND_DEFAULT,
  // The dotfiles rule the regular-expression version shipped as its default,
  // said again in the syntax that replaced it.
  hiddenRules: "startsWith::.",
  hiddenEnabled: true,
  hiddenIgnoreCase: true,
  hiddenExcludeList: true,
  hiddenStatusBar: true,
  hiddenRibbonButton: true,
  hiddenExcludeEntries: [],
  orderButton: true,
  orderMode: false,
  orderMap: {},
  attachmentTemplate: 'file-${date:YYYYMMDDHHmmssSSS}',
  attachmentFolder: './assets/${noteFileName}',
  attachmentSpecialChars: "#^[]|*\\<>?:/",
  attachmentSpecialCharsReplacement: "-",
  syncAttachmentsOnRename: true,
  syncAttachmentsOnMove: true,
  attachmentDuplicateSeparator: "-",
  emptyFolderHandling: "delete-and-parents",
  deleteOrphanedOnNoteDelete: true,

  // The table editor keeps the diagram editor's auto-save courtesy: a formula
  // you are mid-edit is not something you want to lose to a stray Ctrl+W.
  tableAutoSave: true,
  tableAutoSaveInterval: 30,
  // The `ƒ` marker is what makes a computed cell legible as computed; on by
  // default so a freshly-framed table reads the same in all three contexts.
  tableHighlightFormulas: true,

  // 功能总开关（0.21.0）。默认只开工具栏、表格、图表三类核心编辑能力；
  // 附件处理、文件隐藏、文件排序默认关，需要时在「功能」标签页打开。
  features: {
    toolbar: true,
    table: true,
    diagram: true,
    attachment: false,
    hiding: false,
    order: false,
  },
};

/**
 * Marks a toolbar row that the search box has filtered out.
 *
 * A class rather than `hidden` or an inline style, for two reasons: the rows
 * are hidden and shown again on every keystroke (so the toggle has to be
 * cheap and CSS-only), and the reorder code reads the list's children by
 * position — leaving the rows in place keeps that reading valid whether or
 * not a search is running.
 */
const FILTERED_ROW = "mtk-toolbar-cmd-filtered";

/**
 * The text a row is searched by: the name it is drawn with, plus the command
 * id a leaf shows underneath it — so `undo` and `editor:undo` both find the
 * same button, whichever language the name happens to be in.
 *
 * A section heading is the exception. It has no command to run, and its id
 * line is the literal words for "section heading", so including it would
 * return every heading in the toolbar for a query that has nothing to do
 * with headings.
 */
function searchText(row: HTMLElement): string {
  const header = row.querySelector(":scope > .mtk-toolbar-cmd") ?? row;
  const name = header.querySelector(".mtk-toolbar-cmd-name")?.textContent ?? "";
  if (row.classList.contains("is-group")) return name;
  const id = header.querySelector(".mtk-toolbar-cmd-id")?.textContent ?? "";
  return `${name} ${id}`;
}

/**
 * Marks a diagram-type row that the search box has taken out.
 *
 * A second constant rather than a shared one with `FILTERED_ROW`: each hiding
 * rule is scoped to its own list, and both need that ancestor in front of it to
 * beat the row's own `display: grid` — `.mtk-toolbar-cmd-list` for the toolbar,
 * `.mtk-kinds-list` for the reference.
 */
const FILTERED_KIND_ROW = "mtk-kind-filtered";

/**
 * The parts of a diagram-type row the search box reads: the name it is drawn
 * with, the keyword someone types into a fence, and the sentence saying when to
 * reach for it.
 *
 * The answer the row ends with is left out on purpose. It holds one of two
 * words, so including it would answer half the list for a query like "yes" —
 * the same reason the toolbar searches a section heading by its name alone.
 */
const KIND_SEARCH_CELLS = [".mtk-kind-name", ".mtk-kind-keyword", ".mtk-kind-scene"];

function kindSearchText(row: HTMLElement): string {
  const parts: string[] = [];
  for (const selector of KIND_SEARCH_CELLS) {
    const text = row.querySelector(selector)?.textContent;
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

/**
 * Every formula the table editor can evaluate, in the ƒ menu's order.
 *
 * Mirrors `AGGREGATES` in `core/table-formula.ts` — five aggregate functions,
 * then the arithmetic path (cell references substituted into a `+ - * /`
 * expression), which is not a named function but is a formula a user can
 * write. Keys are spelled out in full rather than built by prefix so the i18n
 * checker sees each one as a reference.
 */
const TABLE_FORMULAS: ReadonlyArray<{ keyword: string; nameKey: string; sceneKey: string }> = [
  { keyword: "sum", nameKey: "settings.formula.sum.name", sceneKey: "settings.formula.sum.scene" },
  { keyword: "avg", nameKey: "settings.formula.avg.name", sceneKey: "settings.formula.avg.scene" },
  {
    keyword: "count",
    nameKey: "settings.formula.count.name",
    sceneKey: "settings.formula.count.scene",
  },
  { keyword: "max", nameKey: "settings.formula.max.name", sceneKey: "settings.formula.max.scene" },
  { keyword: "min", nameKey: "settings.formula.min.name", sceneKey: "settings.formula.min.scene" },
  {
    keyword: "=B2-C2",
    nameKey: "settings.formula.arithmetic.name",
    sceneKey: "settings.formula.arithmetic.scene",
  },
];

export class MarkdownEditorPlusSettingTab extends PluginSettingTab {
  private readonly plugin: MarkdownEditorPlusPlugin;
  /**
   * Which submenus are open, by entry id.
   *
   * Held here rather than in the DOM so a re-render (after an edit or a delete)
   * puts the rows back the way the user left them. Empty submenus ignore this
   * and always show their contents, since a collapsed menu with nothing in it
   * would look like a button that does nothing.
   */
  private readonly openSubmenus = new Set<string>();

  /**
   * What is typed in the toolbar's search box.
   *
   * Kept here for the same reason `openSubmenus` is: every edit — an add, a
   * delete, a rename, a reorder — re-renders the list, and a filter that
   * forgot its own text would drop the user back onto the full list halfway
   * through the search they were using to find the row.
   */
  private toolbarQuery = "";

  /**
   * What is typed in the diagram-type search box.
   *
   * A field of its own rather than a shared one with the toolbar's box: the two
   * filter different lists on different tabs, and one query would mean clearing
   * a search for "gantt" here quietly narrowed the toolbar list too.
   */
  private kindQuery = "";

  /**
   * What is typed in the table-formula search box.
   *
   * Its own field for the same reason the three above are separate: the table
   * tab filters a different list on a different tab, and one shared query would
   * mean clearing a search for "sum" here quietly narrowing the diagram list
   * one tab over.
   */
  private formulaQuery = "";

  /**
   * What is typed in the file-order tab's search box.
   *
   * Its own field for the same reason the two above are separate: the three
   * filter different lists on different tabs, and one shared query would mean
   * clearing a search for a folder here quietly narrowing another tab's list.
   * Kept across the re-renders a deletion causes, so clearing one folder's
   * order does not throw away the search the user was using to find it.
   */
  private orderQuery = "";

  /**
   * Which records are open, by path, for as long as this tab stays open.
   *
   * Held here rather than read off the DOM so a rebuild — and this tab rebuilds
   * itself after every single-record clear — hands back the tree the user had
   * opened instead of folding everything up. Left to reset with the tab, like
   * the searches: what is open is a property of the visit, not of the vault.
   */
  private expandedOrders = new Set<string>();

  /**
   * Counter behind the trees' element ids.
   *
   * Every tree needs an id for its toggle's `aria-controls` to point at, and an
   * id has to be unique in the document — the settings pane is one document
   * wide, so a counter is enough and no path has to be escaped into an id.
   */
  private orderTreeSeq = 0;

  constructor(app: App, plugin: MarkdownEditorPlusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    /* A colour panel is parented to the body, so it is not something
       `empty()` can take down with everything else. Escape and a press
       elsewhere both close it, which covers every way the settings pane is
       normally left — this is for the one that skips both, and its cost is a
       line where its absence would be a panel floating over the app with a
       button that no longer exists behind it. */
    closeColorPicker();
    containerEl.empty();

    const tabBar = h("div", { cls: "mtk-tabs hint-fade" });
    const panelHost = h("div", { cls: "mtk-tab-panels" });
    containerEl.appendChild(tabBar);
    containerEl.appendChild(panelHost);

    /* ---- 溢出：放不下不再折行，改为隐藏 + 鼠标横向拖动查看（边缘渐隐提示）----
       逻辑全部走类名切换（不写内联样式，符合 no-static-styles-assignment）；
       边缘渐隐的 mask 直接打在 .mtk-tabs 上，无需额外包裹层。 */
    const syncOverflow = (): void => {
      const max = tabBar.scrollWidth - tabBar.clientWidth;
      const over = max > 1;
      const atStart = tabBar.scrollLeft <= 1;
      const atEnd = tabBar.scrollLeft >= max - 1;
      tabBar.classList.toggle("is-overflow-start", over && !atStart);
      tabBar.classList.toggle("is-overflow-end", over && !atEnd);
    };

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;
    let pointerId: number | null = null;

    tabBar.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;            // 只处理左键
      dragging = true;
      moved = false;
      startX = e.clientX;
      startScroll = tabBar.scrollLeft;
      pointerId = e.pointerId;
      tabBar.dataset.dragMoved = "";          // 新一次交互先清掉"刚拖过"标记
      // 注意：此处【不】调用 setPointerCapture。若在 pointerdown 就捕获，
      // 合成 click 会被重定向到 tabBar 而非被点的按钮，按钮的 click 监听不触发，
      // 表现就是"点不动其它标签页"。捕获改到下方真正进入拖动时再调用。
    });

    tabBar.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) > 4) {       // 4px 阈值：区分"点击"与"拖动"
        moved = true;
        tabBar.classList.add("is-dragging");
        // 只有越过阈值、确认是拖动时才捕获指针：纯点击不经过捕获，
        // 按钮 click 正常触发可切标签；拖动时捕获保证指针移出标签栏仍能跟手。
        try { tabBar.setPointerCapture(e.pointerId); } catch (e) { /* 无 capture 的环境照常工作 */ }
      }
      if (!moved) return;
      tabBar.scrollLeft = startScroll - dx;
      e.preventDefault();
      syncOverflow();
    });

    const endDrag = (): void => {
      if (!dragging) return;
      dragging = false;
      tabBar.classList.remove("is-dragging");
      if (pointerId !== null) {
        try { tabBar.releasePointerCapture(pointerId); } catch (e) { /* 同上 */ }
      }
      if (moved) tabBar.dataset.dragMoved = "1";   // 让紧随其后的 click 失效
      moved = false;
      syncOverflow();
    };
    tabBar.addEventListener("pointerup", endDrag);
    tabBar.addEventListener("pointercancel", endDrag);
    tabBar.addEventListener("dragstart", (e: Event) => e.preventDefault());
    tabBar.addEventListener("scroll", syncOverflow);

    /* 面板宽度变化（拖侧栏 / 窗口缩放）时重新计算提示。引用挂在元素上，
       元素随设置页关闭被销毁即随 GC 回收，不会泄漏。 */
    const overflowObserver = new ResizeObserver(() => syncOverflow());
    overflowObserver.observe(tabBar);
    (tabBar as unknown as { __overflowObserver?: ResizeObserver }).__overflowObserver = overflowObserver;

    type ModuleTab = { id: string; feature: FeatureKey; label: string; render: (host: HTMLElement) => void };
    const moduleTabs: ModuleTab[] = [
      { id: "toolbar", feature: "toolbar", label: t("settings.tab.toolbar"), render: (host) => this.renderToolbar(host) },
      { id: "table", feature: "table", label: t("settings.tab.table"), render: (host) => this.renderTable(host) },
      { id: "general", feature: "diagram", label: t("settings.tab.general"), render: (host) => this.renderGeneral(host) },
      { id: "attachment", feature: "attachment", label: t("settings.tab.attachment"), render: (host) => this.renderAttachment(host) },
      { id: "hiding", feature: "hiding", label: t("settings.tab.hiding"), render: (host) => this.renderFileHiding(host) },
      { id: "order", feature: "order", label: t("settings.tab.order"), render: (host) => this.renderFileOrder(host) },
    ];

    /* 功能标签页固定最左、始终可见；其余标签页按功能总开关过滤。 */
    const tabs: Array<{ id: string; feature?: FeatureKey; label: string; render: (host: HTMLElement) => void }> = [
      { id: "features", label: t("settings.tab.features"), render: (host) => this.renderFeatures(host) },
      ...moduleTabs.filter((tab) => this.plugin.settings.features[tab.feature]),
    ];

    let activeButton: HTMLElement | null = null;
    const select = (index: number): void => {
      tabs.forEach((tab, i) => {
        const btn = tabBar.children[i] as HTMLElement;
        const on = i === index;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", String(on));
      });
      panelHost.empty();
      tabs[index].render(panelHost);
      activeButton = tabBar.children[index] as HTMLElement;
      if (activeButton && activeButton.scrollIntoView) {
        activeButton.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      syncOverflow();
    };

    tabs.forEach((tab, index) => {
      const btn = h("button", {
        cls: "mtk-tab settings-tab" + (index === 0 ? " is-active" : ""),
        text: tab.label,
        attr: { type: "button", role: "tab", "aria-selected": index === 0 ? "true" : "false" },
      });
      btn.addEventListener("click", () => {
        if (tabBar.dataset.dragMoved === "1") return;   // 拖动后抑制误触切换
        select(index);
      });
      tabBar.appendChild(btn);
    });

    select(0);
  }

  /* ------------------------------------------------------------- features */

  /**
   * The 功能 tab: one master switch per module.
   *
   * Each switch writes straight through to `settings.features`, then the panel
   * re-renders from that same object — so the module's own settings tab appears
   * or disappears in step, and `applyFeatureToggles` flips the editor feature to
   * match. The 功能 tab itself is never one of the switchable modules.
   */
  private renderFeatures(host: HTMLElement): void {
    new Setting(host)
      .setName(t("settings.feature.header.name"))
      .setDesc(t("settings.feature.header.desc"));

    const defs: Array<{ key: FeatureKey; name: string; desc: string }> = [
      { key: "toolbar", name: t("settings.feature.toolbar.name"), desc: t("settings.feature.toolbar.desc") },
      { key: "table", name: t("settings.feature.table.name"), desc: t("settings.feature.table.desc") },
      { key: "diagram", name: t("settings.feature.diagram.name"), desc: t("settings.feature.diagram.desc") },
      { key: "attachment", name: t("settings.feature.attachment.name"), desc: t("settings.feature.attachment.desc") },
      { key: "hiding", name: t("settings.feature.hiding.name"), desc: t("settings.feature.hiding.desc") },
      { key: "order", name: t("settings.feature.order.name"), desc: t("settings.feature.order.desc") },
    ];

    for (const def of defs) {
      new Setting(host)
        .setName(def.name)
        .setDesc(def.desc)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.features[def.key]).onChange(async (value) => {
            this.plugin.settings.features[def.key] = value;
            await this.plugin.saveSettings();
            this.plugin.applyFeatureToggles();
            // 重新渲染标签栏：被关掉的标签页立即消失，新开的立即出现，
            // 激活态自然回到最左的「功能」标签页。
            this.display();
          })
        );
    }
  }

  /* ---------------------------------------------------------------- table */

  /**
   * The table tab: the table editor's own auto-save, separate from the diagram
   * editor's.
   *
   * Every change is written and acted on immediately. The note behind the
   * settings dialog is where the effect shows, so an auto-save cadence that
   * only arrived after a reload would read as one that had not been saved.
   */
  private renderTable(host: HTMLElement): void {
    // The table editor gets its own auto-save, separate from the diagram
    // editor's: the two are different editors with different lifecycles, and
    // folding them into one switch would force a table user to inherit the
    // diagram's cadence. Built detached so the switch can disable the slider.
    const tableIntervalRow = this.buildTableAutoSaveInterval();

    new Setting(host)
      .setName(t("settings.table.autoSave.name"))
      .setDesc(t("settings.table.autoSave.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.tableAutoSave).onChange(async (value) => {
          this.plugin.settings.tableAutoSave = value;
          tableIntervalRow.setEnabled(value);
          await this.plugin.saveSettings();
        })
      );

    tableIntervalRow.setEnabled(this.plugin.settings.tableAutoSave);
    host.appendChild(tableIntervalRow.row.settingEl);

    new Setting(host)
      .setName(t("settings.table.highlightFormulas.name"))
      .setDesc(t("settings.table.highlightFormulas.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.tableHighlightFormulas).onChange(async (value) => {
          this.plugin.settings.tableHighlightFormulas = value;
          this.plugin.refreshTables();
          await this.plugin.saveSettings();
        })
      );

    host.appendChild(this.buildFormulaReference());
  }

  /* -------------------------------------------------------------- general */

  private renderGeneral(host: HTMLElement): void {

    /* The interval row is built off-document first, then moved into place below
       the switch. The switch owns the only reference to it — turning auto-save
       off has to disable the slider in the same breath — and it can only hold
       one for something that already exists. */
    const intervalRow = this.buildAutoSaveInterval();

    new Setting(host)
      .setName(t("settings.autoSave.name"))
      .setDesc(t("settings.autoSave.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSave).onChange(async (value) => {
          this.plugin.settings.autoSave = value;
          intervalRow.setEnabled(value);
          // Pushed into editors that are already open, not just the next one:
          // the settings tab can be visited without closing the diagram, and a
          // switch that only took effect later would look broken.
          this.plugin.syncAutoSave();
          await this.plugin.saveSettings();
        })
      );

    intervalRow.setEnabled(this.plugin.settings.autoSave);
    host.appendChild(intervalRow.row.settingEl);

    host.appendChild(this.buildReference());
  }

  /**
   * The interval row: a slider and a button that puts it back to the default.
   *
   * Built detached and returned rather than appending itself — see the comment
   * at its call site for why the order cannot be written top to bottom here.
   *
   * The number itself is Obsidian's own: a slider shows its value inline these
   * days, and a second copy beside the track would read as two different
   * settings.
   */
  private buildAutoSaveInterval(): { row: Setting; setEnabled: (on: boolean) => void } {
    const fallback = DEFAULT_SETTINGS.autoSaveInterval;
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.autoSaveInterval.name"))
      .setDesc(t("settings.autoSaveInterval.desc"));

    let slider: SliderComponent | null = null;

    const apply = async (value: number): Promise<void> => {
      this.plugin.settings.autoSaveInterval = value;
      this.plugin.syncAutoSave();
      await this.plugin.saveSettings();
    };

    setting.addSlider((component) => {
      slider = component;
      component
        .setLimits(MIN_AUTO_SAVE_SECONDS, MAX_AUTO_SAVE_SECONDS, AUTO_SAVE_STEP)
        .setValue(this.plugin.settings.autoSaveInterval)
        // Still worth asking for: this is what shows the number while the handle
        // is being dragged, on the app versions that predate the inline readout.
        .setDynamicTooltip()
        .onChange((value) => void apply(value));
    });

    setting.addExtraButton((button) =>
      button
        .setIcon("rotate-ccw")
        .setTooltip(t("settings.autoSaveInterval.reset", { value: String(fallback) }))
        .onClick(() => {
          // The handle is moved as well as the setting: `SliderComponent` keeps
          // its own copy of the value, and a reset that left the handle where it
          // was would read as a button that did nothing.
          slider?.setValue(fallback);
          void apply(fallback);
        })
    );

    // Gating is slider-only, on purpose: `Setting.setDisabled` would mark the
    // whole row `is-disabled` and dim the name and description along with the
    // control, making the option itself look switched off. The reset button
    // stays live as well — resetting a dormant value is harmless.
    const setEnabled = (on: boolean): void => {
      slider?.setDisabled(!on);
    };

    return { row: setting, setEnabled };
  }

  /**
   * The table auto-save interval row — a slider and a reset button, mirrored
   * from `buildAutoSaveInterval` but reading and writing `tableAutoSaveInterval`.
   *
   * No live push to an open editor: the table editor is a transient modal that
   * reads the interval when it opens, unlike the diagram editor's long-lived
   * session. Built detached for the same "switch owns the reference" reason.
   */
  private buildTableAutoSaveInterval(): { row: Setting; setEnabled: (on: boolean) => void } {
    const fallback = DEFAULT_SETTINGS.tableAutoSaveInterval;
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.table.autoSaveInterval.name"))
      .setDesc(t("settings.table.autoSaveInterval.desc"));

    let slider: SliderComponent | null = null;

    const apply = async (value: number): Promise<void> => {
      this.plugin.settings.tableAutoSaveInterval = value;
      await this.plugin.saveSettings();
    };

    setting.addSlider((component) => {
      slider = component;
      component
        .setLimits(MIN_AUTO_SAVE_SECONDS, MAX_AUTO_SAVE_SECONDS, AUTO_SAVE_STEP)
        .setValue(this.plugin.settings.tableAutoSaveInterval)
        .setDynamicTooltip()
        .onChange((value) => void apply(value));
    });

    setting.addExtraButton((button) =>
      button
        .setIcon("rotate-ccw")
        .setTooltip(t("settings.table.autoSaveInterval.reset", { value: String(fallback) }))
        .onClick(() => {
          // Move the handle as well as the setting, or the reset reads as dead.
          slider?.setValue(fallback);
          void apply(fallback);
        })
    );

    const setEnabled = (on: boolean): void => {
      slider?.setDisabled(!on);
    };

    return { row: setting, setEnabled };
  }

  /**
   * The list of every diagram kind this plugin can draw.
   *
   * It is the toolbar tab's list, one tab over: the same card (a hairline
   * frame, the same corner radius, the same 13px) and the same row rhythm (a
   * divider between rows, none after the last). What a row holds differs,
   * because this is a reference rather than a control — there is nothing here
   * to arrange, so a row carries no grip, no edit button and no delete. The
   * name and the answer share the first line, and the keyword and the scene sit
   * under them on a second, which is the shape the toolbar's own rows use for a
   * name over its command id.
   *
   * The header row left with the table. It was the only thing naming the
   * columns, and it was also the only reason the keyword had to fit a column of
   * its own — `sequenceDiagram` is the widest thing in the list, and on a
   * second line it has the whole row to sit in.
   */
  private buildReference(): HTMLElement {
    const wrap = h("div", { cls: "mtk-kinds" });

    const list = h("ul", { cls: "mtk-kinds-list" });
    for (const kind of DIAGRAM_KINDS) {
      const row = h("li");
      row.appendChild(h("span", { cls: "mtk-kind-name", text: t(kind.nameKey) }));
      row.appendChild(
        h("span", {
          cls: kind.mode ? "mtk-kind-can-edit" : "mtk-kind-cannot-edit",
          text: kind.mode ? t("settings.kinds.yes") : t("settings.kinds.no"),
        })
      );

      /* The two lookups share the row's second line. Keyword first, because it
         is the one people arrive with — "which diagram is `gantt`?" — and the
         scene is the sentence that explains it. */
      const sub = h("span", { cls: "mtk-kind-sub" });
      sub.appendChild(h("span", { cls: "mtk-kind-keyword", text: kind.keyword }));
      sub.appendChild(h("span", { cls: "mtk-kind-scene", text: t(kind.sceneKey) }));
      row.appendChild(sub);

      list.appendChild(row);
    }

    // The sentence about an empty result lands under the list rather than in
    // place of it, the same way it does on the toolbar tab: the rows the search
    // took out keep their places in the list, so the box can be cleared and
    // hand back exactly what was there.
    const noMatch = h("p", {
      cls: "mtk-kinds-search-empty",
      text: t("settings.kinds.searchEmpty"),
      attr: { hidden: "hidden" },
    });

    wrap.appendChild(this.buildKindSearch(list, noMatch).settingEl);
    wrap.appendChild(list);
    wrap.appendChild(noMatch);

    this.applyKindFilter(list, noMatch);
    return wrap;
  }

  /**
   * The search row that sits above the list.
   *
   * The reference is a fixed list, so the everyday job is finding one row in
   * it, and reading ten of them for "gantt" is work the box can do.
   *
   * It filters in place rather than rebuilding the list: rows are never added
   * or removed, only marked, so the caret stays in the box across a keystroke.
   * The box is refilled from `kindQuery`, so leaving the tab and coming back
   * hands the user the same view they left instead of the full list.
   *
   * It is a `Setting` row, not a hand-drawn card, so it inherits whatever the
   * theme paints the other rows of this tab with — the previous custom card
   * drew its own border and background and read as a stranger next to them.
   * Built off-document and moved into place by the caller, like the interval
   * row above.
   */
  private buildKindSearch(list: HTMLElement, noMatch: HTMLElement): Setting {
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.kinds.searchTitle"))
      .setDesc(t("settings.kinds.searchDesc"));

    setting.addText((text) =>
      text
        .setPlaceholder(t("settings.kinds.searchPlaceholder"))
        .setValue(this.kindQuery)
        .onChange((value) => {
          this.kindQuery = value;
          this.applyKindFilter(list, noMatch);
        })
    );

    return setting;
  }

  /**
   * Shows only the rows whose name, keyword or scene contains the query.
   *
   * Every pass starts from scratch — the query and the row's own text, nothing
   * carried over — so clearing the box restores the full list rather than
   * whatever the last search happened to leave behind.
   */
  private applyKindFilter(list: HTMLElement, noMatch: HTMLElement): void {
    this.applyListFilter(list, noMatch, this.kindQuery);
  }

  /**
   * The one filter both reference lists share.
   *
   * Shows only the rows whose name, keyword or scene contains the query, so
   * the diagram list and the formula list filter by the same three cells —
   * they are drawn with the same row shape, and the formula rows carry the
   * same classes, so `kindSearchText` reads them without knowing the
   * difference.
   *
   * Every pass starts from scratch — the query and the row's own text, nothing
   * carried over — so clearing the box restores the full list rather than
   * whatever the last search happened to leave behind.
   */
  private applyListFilter(list: HTMLElement, noMatch: HTMLElement, query: string): void {
    const needle = query.trim().toLowerCase();
    let visible = 0;
    for (const row of Array.from(list.children)) {
      if (!(row instanceof HTMLElement)) continue;
      const shown = needle.length === 0 || kindSearchText(row).toLowerCase().includes(needle);
      row.classList.toggle(FILTERED_KIND_ROW, !shown);
      if (shown) visible += 1;
    }
    noMatch.toggleAttribute("hidden", !(needle.length > 0 && visible === 0));
  }

  /**
   * The list of every formula the table editor can evaluate.
   *
   * The table tab's own copy of the diagram tab's reference: the same card —
   * the same `.mtk-kinds` classes, so the theme paints both lists with one set
   * of rules and a fix to one row shape lands on both — with the formula table
   * in place of the diagram kinds. Every row is supported, so the answer the
   * row ends with is always the same word and carries no condition.
   */
  private buildFormulaReference(): HTMLElement {
    const wrap = h("div", { cls: "mtk-kinds" });

    const list = h("ul", { cls: "mtk-kinds-list" });
    for (const formula of TABLE_FORMULAS) {
      const row = h("li");
      row.appendChild(h("span", { cls: "mtk-kind-name", text: t(formula.nameKey) }));
      row.appendChild(h("span", { cls: "mtk-kind-can-edit", text: t("settings.kinds.yes") }));

      /* The same two lookups share the row's second line: the keyword someone
         writes in a cell arrives first, the sentence that explains it second. */
      const sub = h("span", { cls: "mtk-kind-sub" });
      sub.appendChild(h("span", { cls: "mtk-kind-keyword", text: formula.keyword }));
      sub.appendChild(h("span", { cls: "mtk-kind-scene", text: t(formula.sceneKey) }));
      row.appendChild(sub);

      list.appendChild(row);
    }

    // The sentence about an empty result lands under the list rather than in
    // place of it, the same way it does on the diagram tab: the rows the
    // search took out keep their places in the list, so the box can be
    // cleared and hand back exactly what was there.
    const noMatch = h("p", {
      cls: "mtk-kinds-search-empty",
      text: t("settings.formula.searchEmpty"),
      attr: { hidden: "hidden" },
    });

    wrap.appendChild(this.buildFormulaSearch(list, noMatch).settingEl);
    wrap.appendChild(list);
    wrap.appendChild(noMatch);

    this.applyListFilter(list, noMatch, this.formulaQuery);
    return wrap;
  }

  /**
   * The search row that sits above the formula list.
   *
   * The reference is a fixed list, so the everyday job is finding one row in
   * it — "which one was `count` again?" — and reading six of them for it is
   * work the box can do. It filters in place rather than rebuilding the list
   * (rows are only marked, so the caret stays across a keystroke) and refills
   * from `formulaQuery`, so leaving the tab and coming back hands the user
   * the same view they left.
   */
  private buildFormulaSearch(list: HTMLElement, noMatch: HTMLElement): Setting {
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.formula.searchTitle"))
      .setDesc(t("settings.formula.searchDesc"));

    setting.addText((text) =>
      text
        .setPlaceholder(t("settings.formula.searchPlaceholder"))
        .setValue(this.formulaQuery)
        .onChange((value) => {
          this.formulaQuery = value;
          this.applyListFilter(list, noMatch, this.formulaQuery);
        })
    );

    return setting;
  }

  /* -------------------------------------------------------------- toolbar */

  /*
   * The tab is three things: one row that sets what the bar is painted on, one
   * that both explains and performs "add", and the list itself.
   *
   * The background row comes first because it answers a question about the bar
   * rather than about the rows — everything under it is "which commands are
   * there", and a reader who meets the list first has to be told the bar has a
   * colour at all before they can care which it is.
   *
   * The "clear all" block that used to sit above the card is gone as well. It
   * was the only caller of the confirmation modal, and the list it emptied is
   * the same list whose rows each carry their own delete action, so the way out
   * of a toolbar somebody regrets building is to remove the rows — not to throw
   * the whole thing away behind a prompt.
   *
   * The per-feature shortcut cards that used to sit between the card and the
   * list are gone. Every entry they offered — the text tools, the alignment
   * submenu, the two colour buttons, the focus-mode button — is a registered
   * command, so "Add command" reaches all of them from one place rather than
   * six, and there is no second list of bundled entries to keep in step with
   * the command table. The custom swatch editors went with them: the two
   * palettes still draw whatever the settings hold, which is the default set
   * for anyone who never changed it.
   *
   * `replaceChildren()` is what makes the re-render safe. Appending a second
   * copy of the page on every edit is what the first version did, so the intro
   * and the buttons multiplied once a command had been added.
   */
  private renderToolbar(host: HTMLElement): void {
    host.replaceChildren();

    // Obsidian's own mobile toolbar is hidden unconditionally since the
    // switch that used to live here was removed: this plugin's pinned bar
    // replaces it, which is the whole point of installing the plugin.

    const commands = this.plugin.settings.toolbarCommands;

    const list = h("ul", { cls: "mtk-toolbar-cmd-list" });
    if (commands.length === 0) {
      list.appendChild(
        h("li", { cls: "mtk-toolbar-cmd-empty", text: t("settings.toolbar.empty") })
      );
    } else {
      for (const cmd of commands) list.appendChild(this.buildRow(host, commands, list, cmd, null));
    }

    // Two different sentences, so two different elements: "nothing here yet"
    // belongs to the list, "nothing matched what you typed" belongs to the
    // search and takes the list's place for as long as it is true.
    const noMatch = h("p", {
      cls: "mtk-toolbar-search-empty",
      text: t("settings.toolbar.searchEmpty"),
      attr: { hidden: "hidden" },
    });

    host.appendChild(this.buildToolbarBackground());
    host.appendChild(this.buildAddCard(host));
    // Nothing to search before the first command is added.
    if (commands.length > 0) host.appendChild(this.buildToolbarSearch(list, noMatch));
    host.appendChild(list);
    host.appendChild(noMatch);

    this.applyToolbarFilter(list, noMatch);
  }

  /**
   * The row that sets the colour behind the bar.
   *
   * A `Setting` row now, like the rest of this tab, so it inherits the theme's
   * row chrome instead of painting its own card. The choice itself has been
   * reduced to two answers that a dropdown names better than a palette shows:
   * "follow the theme" (the default — the property stays unset and
   * `styles.css`'s `var()` fallback paints the bar) and "transparent" (the note
   * shows through the strip). The old preview button, colour panel and reset
   * action are gone with them: with nothing left to paint, a select that says
   * which state is current is the whole control.
   */
  private buildToolbarBackground(): HTMLElement {
    /* Read defensively, like the bar itself: a `data.json` written before this
       field existed has no value to hand back. */
    const stored = (): string => {
      const value = this.plugin.settings.editorToolbarBackground;
      return typeof value === "string" ? value : TOOLBAR_BACKGROUND_DEFAULT;
    };

    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.toolbar.bg.title"))
      .setDesc(t("settings.toolbar.bg.desc"));

    /** Writes the choice down, then repaints the bar in the editor. */
    const write = (value: string): void => {
      this.plugin.settings.editorToolbarBackground = value;
      /* Repainted here rather than on the next visit to this tab: the editor is
         usually open behind the settings dialog, and a colour that only showed
         up after a reload would read as one that had not been saved. */
      this.plugin.refreshToolbar();
      void this.plugin.saveSettings();
    };

    setting.addDropdown((dropdown) => {
      dropdown
        .addOption(TOOLBAR_BACKGROUND_DEFAULT, t("settings.toolbar.bg.followTheme"))
        .addOption(TOOLBAR_BACKGROUND_TRANSPARENT, t("settings.toolbar.bg.transparent"))
        .setValue(stored())
        .onChange((value) => write(value));
    });

    return setting.settingEl;
  }

  /**
   * The row that carries both the instructions and the two "add" buttons.
   *
   * The third button — "add a section heading" — is gone. A heading is still a
   * row type the bundled submenus emit (the text tools group their entries
   * under one), so those render and edit exactly as before; what is gone is the
   * only way to conjure a *new* one, which dropped a title row into the toolbar
   * with nothing under it.
   *
   * Both buttons are labelled rather than drawn as icons. A plus and a hamburger
   * meant nothing until you hovered them, and the two actions are not guessable
   * from a glyph: one picks a command, the other starts a group. They reuse the
   * generic button pair, accent for the common action and neutral for the
   * quieter one, so their wording is also their accessible name.
   */
  private buildAddCard(host: HTMLElement): HTMLElement {
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.toolbar.addTitle"))
      .setDesc(t("settings.toolbar.addDesc"));

    const addBtn = h("button", {
      cls: "mtk-btn mtk-btn-primary",
      text: t("settings.toolbar.add"),
      attr: { type: "button" },
    });
    addBtn.addEventListener("click", () => this.openCommandModal(host, this.plugin.settings.toolbarCommands, null));
    setting.controlEl.appendChild(addBtn);

    const submenuBtn = h("button", {
      cls: "mtk-btn",
      text: t("settings.toolbar.addSubmenu"),
      attr: { type: "button" },
    });
    submenuBtn.addEventListener("click", () => {
      this.openSubmenuModal(host, this.plugin.settings.toolbarCommands, null);
    });
    setting.controlEl.appendChild(submenuBtn);

    return setting.settingEl;
  }

  /**
   * The search row that sits between the "add" row and the list.
   *
   * A box rather than a second picker: with a toolbar the user has settled
   * on, the everyday job is finding a row that is already there, and on this
   * tab the list is the only thing long enough to need help finding.
   *
   * It filters in place instead of re-rendering the tab — a rebuild on every
   * keystroke would take the caret back out of the box. The box is refilled
   * from `toolbarQuery` so a rebuild caused by something else (adding a
   * command, deleting a row) hands back the same filtered view.
   */
  private buildToolbarSearch(list: HTMLElement, noMatch: HTMLElement): HTMLElement {
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.toolbar.searchTitle"))
      .setDesc(t("settings.toolbar.searchDesc"));

    const input = h("input", {
      cls: "mtk-toolbar-search-input",
      attr: {
        type: "search",
        spellcheck: "false",
        placeholder: t("settings.toolbar.searchPlaceholder"),
        "aria-label": t("settings.toolbar.searchTitle"),
      },
    });
    input.value = this.toolbarQuery;
    input.addEventListener("input", () => {
      this.toolbarQuery = input.value;
      this.applyToolbarFilter(list, noMatch);
    });
    setting.controlEl.appendChild(input);
    return setting.settingEl;
  }

  /**
   * Shows only the rows whose name — or command id — contains the query.
   *
   * Nothing is carried between passes: each keystroke is answered afresh from
   * three facts (the query, the row's own text, `openSubmenus`), so clearing
   * the box restores exactly the list the user had, rather than whatever the
   * last search left behind. A submenu survives when it matches itself **or**
   * when a row inside it does, and a submenu kept only by a child is opened —
   * a hit inside a collapsed menu is a hit nobody can see.
   */
  private applyToolbarFilter(list: HTMLElement, noMatch: HTMLElement): void {
    const needle = this.toolbarQuery.trim().toLowerCase();
    let visible = 0;
    for (const row of Array.from(list.children)) {
      if (row instanceof HTMLElement && this.filterRow(row, needle)) visible += 1;
    }

    const filtering = needle.length > 0;
    const none = filtering && visible === 0;
    // `is-filtering` is what takes the drag handles out of play: the hidden
    // rows keep their place in the array, so a drag among the visible ones
    // would be deciding where the invisible ones go.
    list.classList.toggle("is-filtering", filtering);
    list.classList.toggle("is-no-match", none);
    noMatch.toggleAttribute("hidden", !none);
  }

  /** Filters one row, and answers whether it stayed visible. */
  private filterRow(row: HTMLElement, needle: string): boolean {
    const kids = row.querySelector(":scope > .mtk-toolbar-cmd-children");
    let childHit = false;
    if (kids) {
      for (const child of Array.from(kids.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const hit = this.filterRow(child, needle);
        // The "nothing in here yet" hint is a row on screen but not a result.
        if (hit && !child.classList.contains("mtk-toolbar-cmd-child-empty")) childHit = true;
      }
    }

    const filtering = needle.length > 0;
    const shown = !filtering || childHit || searchText(row).toLowerCase().includes(needle);
    row.classList.toggle(FILTERED_ROW, !shown);
    if (kids instanceof HTMLElement) this.applyGroupOpen(row, kids, filtering, childHit);
    return shown;
  }

  /**
   * Opens or closes one submenu for the current pass.
   *
   * Rebuilt from `openSubmenus` every time and never written back to it, so a
   * search borrows the layout without changing it: the user's own collapsed
   * submenus come back the moment the box is cleared.
   */
  private applyGroupOpen(
    row: HTMLElement,
    kids: HTMLElement,
    filtering: boolean,
    childHit: boolean
  ): void {
    const empty =
      kids.children.length === 0 ||
      kids.querySelector(":scope > .mtk-toolbar-cmd-child-empty") !== null;
    const userOpen = empty || this.openSubmenus.has(row.getAttribute("data-cmd-id") ?? "");
    const open = userOpen || (filtering && childHit);

    kids.toggleAttribute("hidden", !open);
    row.classList.toggle("is-open", open);
    // "Add a command in here" is a question. While filtering, the list is
    // answering one, so the invitation steps aside until the box is cleared.
    row
      .querySelector(":scope > .mtk-toolbar-add-child")
      ?.toggleAttribute("hidden", filtering || !open);
  }

  /**
   * One entry: either a flat row, or a submenu and the rows inside it.
   *
   * `target` is the array the entry actually lives in — the top-level list, or
   * a submenu's children — so every mutation (delete, reorder, replace) can be
   * expressed against the right array instead of being mapped back by index.
   */
  private buildRow(
    host: HTMLElement,
    target: ToolbarCommand[],
    scope: HTMLElement,
    cmd: ToolbarCommand,
    parentId: string | null
  ): HTMLElement {
    if (isGroupLabel(cmd)) return this.buildGroupLabelRow(host, target, scope, cmd);
    if (!isSubmenu(cmd)) return this.buildLeafRow(host, target, scope, cmd, parentId);

    const children = cmd.children ?? [];
    const open = children.length === 0 || this.openSubmenus.has(cmd.id);

    const group = h("li", { cls: "mtk-toolbar-cmd-group", attr: { "data-cmd-id": cmd.id } });
    if (open) group.classList.add("is-open");

    const row = h("div", { cls: "mtk-toolbar-cmd is-parent" });
    // The group is what the list holds, so the group is what a drag moves.
    row.appendChild(this.buildGrip(scope, group, () => this.commitRowOrder(scope, target)));
    row.appendChild(this.buildIconButton(cmd));
    row.appendChild(this.buildSubmenuLabel(cmd, children.length));
    row.appendChild(this.buildToggle(group, cmd, children.length, open));
    row.appendChild(
      this.buildIconAction(
        "pencil",
        t("settings.toolbar.editSubmenu"),
        "mtk-toolbar-cmd-edit",
        () => this.openSubmenuModal(host, target, cmd)
      )
    );
    row.appendChild(this.buildDeleteAction(host, target, cmd));
    group.appendChild(row);

    const kids = h("ul", { cls: "mtk-toolbar-cmd-children" });
    if (!open) kids.setAttribute("hidden", "hidden");
    if (children.length === 0) {
      kids.appendChild(
        h("li", { cls: "mtk-toolbar-cmd-child-empty", text: t("settings.toolbar.submenuEmpty") })
      );
    } else {
      for (const child of children) {
        kids.appendChild(this.buildRow(host, children, kids, child, cmd.id));
      }
    }
    group.appendChild(kids);
    group.appendChild(this.buildAddChild(host, cmd, children));
    return group;
  }

  /** A row that runs one command. `parentId` marks it as a submenu's child. */
  private buildLeafRow(
    host: HTMLElement,
    target: ToolbarCommand[],
    scope: HTMLElement,
    cmd: ToolbarCommand,
    parentId: string | null
  ): HTMLElement {
    // The id, not the position, is what ties a row to its command: a drop moves
    // rows without re-rendering, so positions go stale the moment one is moved.
    const row = h("li", { cls: "mtk-toolbar-cmd", attr: { "data-cmd-id": cmd.id } });
    if (parentId !== null) row.classList.add("is-child");

    row.appendChild(this.buildGrip(scope, row, () => this.commitRowOrder(scope, target)));
    row.appendChild(this.buildIconButton(cmd));
    row.appendChild(this.buildLeafLabel(cmd));
    row.appendChild(
      this.buildIconAction(
        "pencil",
        t("settings.toolbar.edit"),
        "mtk-toolbar-cmd-edit",
        () => this.openCommandModal(host, target, cmd)
      )
    );
    row.appendChild(this.buildDeleteAction(host, target, cmd));
    return row;
  }

  /**
   * A section heading inside a submenu.
   *
   * Its own row shape rather than "a command whose id happens to be empty": it
   * has no command to run and cannot hold children, so it gets a name, a drag
   * handle and a delete button and nothing else. The icon column stays as an
   * invisible spacer, so a heading still lines up with the commands around it.
   *
   * It is editable and reorderable like any other row on purpose: a heading the
   * user cannot move away from the items it labels would be worse than having
   * no heading at all.
   */
  private buildGroupLabelRow(
    host: HTMLElement,
    target: ToolbarCommand[],
    scope: HTMLElement,
    cmd: ToolbarCommand
  ): HTMLElement {
    const row = h("li", {
      cls: "mtk-toolbar-cmd is-child is-group",
      attr: { "data-cmd-id": cmd.id },
    });

    row.appendChild(this.buildGrip(scope, row, () => this.commitRowOrder(scope, target)));
    row.appendChild(h("span", { cls: "mtk-toolbar-cmd-iconbtn-spacer" }));

    const label = h("span", { cls: "mtk-toolbar-cmd-label" });
    label.appendChild(h("span", { cls: "mtk-toolbar-cmd-name", text: this.labelOf(cmd) }));
    label.appendChild(h("span", { cls: "mtk-toolbar-cmd-id", text: t("settings.toolbar.groupLabel") }));
    row.appendChild(label);

    row.appendChild(
      this.buildIconAction("pencil", t("settings.toolbar.editGroupLabel"), "mtk-toolbar-cmd-edit", () =>
        this.openSubmenuModal(host, target, cmd, true)
      )
    );
    row.appendChild(this.buildDeleteAction(host, target, cmd));
    return row;
  }

  /**
   * `moved` is the element the list reorders, which is not always the element
   * the handle sits in: a submenu's handle lives in its header `<div>`, but the
   * list holds the `<li>` that wraps that header *and* the children.
   */
  private buildGrip(scope: HTMLElement, moved: HTMLElement, commit: () => void): HTMLElement {
    const grip = h("span", {
      cls: "mtk-toolbar-cmd-grip",
      attr: { role: "button", tabindex: "0", "aria-label": t("settings.toolbar.reorder") },
    });
    setIcon(grip, "grip-vertical");
    attachRowReorder(scope, moved, grip, commit, "cmdId");
    return grip;
  }

  /**
   * The icon, which doubles as the button that replaces it.
   *
   * The common edit — the one the first version made you open a dialog for —
   * therefore happens in place.
   */
  private buildIconButton(cmd: ToolbarCommand): HTMLElement {
    const iconBtn = h("button", {
      cls: "clickable-icon mtk-toolbar-cmd-iconbtn",
      attr: { type: "button", "aria-label": t("settings.toolbar.pickIcon") },
    });
    setIcon(iconBtn, cmd.icon || "command");
    applyTooltip(iconBtn, t("settings.toolbar.pickIcon"));
    iconBtn.addEventListener("click", () => {
      new IconPickerModal(this.app, cmd.icon, (icon) => {
        cmd.icon = icon;
        setIcon(iconBtn, icon);
        this.applyToolbarChange();
      }).open();
    });
    return iconBtn;
  }

  /** A submenu's name, followed by how many commands it holds. */
  private buildSubmenuLabel(cmd: ToolbarCommand, count: number): HTMLElement {
    const label = h("span", { cls: "mtk-toolbar-cmd-label" });
    const head = h("span", { cls: "mtk-toolbar-cmd-head" });
    head.appendChild(h("span", { cls: "mtk-toolbar-cmd-name", text: this.labelOf(cmd) }));
    head.appendChild(
      h("span", {
        cls: "mtk-toolbar-cmd-badge",
        text: String(count),
        attr: { "aria-label": t("settings.toolbar.submenuCount", { count: String(count) }) },
      })
    );
    label.appendChild(head);
    return label;
  }

  private buildLeafLabel(cmd: ToolbarCommand): HTMLElement {
    const label = h("span", { cls: "mtk-toolbar-cmd-label" });
    label.appendChild(h("span", { cls: "mtk-toolbar-cmd-name", text: this.labelOf(cmd) }));
    label.appendChild(h("span", { cls: "mtk-toolbar-cmd-id", text: cmd.commandId }));
    return label;
  }

  /** Expands or collapses a submenu, without rebuilding the whole tab. */
  private buildToggle(
    group: HTMLElement,
    cmd: ToolbarCommand,
    count: number,
    open: boolean
  ): HTMLElement {
    const toggle = h("button", {
      cls: "clickable-icon mtk-toolbar-cmd-toggle",
      attr: {
        type: "button",
        "aria-label": t("settings.toolbar.submenuToggle"),
        "aria-expanded": String(open),
      },
    });
    setIcon(toggle, "chevron-right");
    applyTooltip(toggle, t("settings.toolbar.submenuToggle"));

    // A submenu with nothing in it has nothing to hide, so the control is off
    // rather than pretending to work.
    if (count === 0) {
      (toggle as HTMLButtonElement).disabled = true;
      return toggle;
    }

    toggle.addEventListener("click", () => {
      const next = !this.openSubmenus.has(cmd.id);
      if (next) this.openSubmenus.add(cmd.id);
      else this.openSubmenus.delete(cmd.id);
      group.classList.toggle("is-open", next);
      toggle.setAttribute("aria-expanded", String(next));
      group.querySelector(".mtk-toolbar-cmd-children")?.toggleAttribute("hidden", !next);
      group.querySelector(".mtk-toolbar-add-child")?.toggleAttribute("hidden", !next);
    });
    return toggle;
  }

  /** The "add a command inside this submenu" strip. */
  private buildAddChild(
    host: HTMLElement,
    cmd: ToolbarCommand,
    children: ToolbarCommand[]
  ): HTMLElement {
    const strip = h("div", { cls: "mtk-toolbar-add-child" });
    if (children.length > 0 && !this.openSubmenus.has(cmd.id)) {
      strip.setAttribute("hidden", "hidden");
    }
    strip.appendChild(
      h("span", { cls: "mtk-toolbar-add-child-desc", text: t("settings.toolbar.addSubCommand") })
    );
    const btn = h("button", {
      cls: "clickable-icon mtk-toolbar-add-child-btn",
      attr: { type: "button", "aria-label": t("settings.toolbar.addSubCommand") },
    });
    setIcon(btn, "plus");
    applyTooltip(btn, t("settings.toolbar.addSubCommand"));
    btn.addEventListener("click", () => this.openCommandModal(host, children, null, cmd));
    strip.appendChild(btn);
    return strip;
  }

  private buildIconAction(
    icon: string,
    label: string,
    cls: string,
    onClick: () => void
  ): HTMLElement {
    const btn = h("button", {
      cls: `clickable-icon ${cls}`,
      attr: { type: "button", "aria-label": label },
    });
    setIcon(btn, icon);
    applyTooltip(btn, label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private buildDeleteAction(
    host: HTMLElement,
    target: ToolbarCommand[],
    cmd: ToolbarCommand
  ): HTMLElement {
    return this.buildIconAction("trash-2", t("settings.toolbar.delete"), "mtk-toolbar-cmd-del", () => {
      const at = target.indexOf(cmd);
      if (at < 0) return;
      target.splice(at, 1);
      this.openSubmenus.delete(cmd.id);
      this.applyToolbarChange();
      this.renderToolbar(host);
    });
  }

  /** The name shown for an entry: the user's label, then the command's name. */
  private labelOf(cmd: ToolbarCommand): string {
    return cmd.label || commandName(this.app, cmd.commandId) || cmd.id;
  }

  /**
   * Opens the dialog for a command, then re-renders so the list is current.
   *
   * `parent` is set when the row belongs to a submenu; the new entry is then
   * appended to that submenu's children rather than to the toolbar itself.
   */
  private openCommandModal(
    host: HTMLElement,
    target: ToolbarCommand[] | null,
    existing: ToolbarCommand | null,
    parent: ToolbarCommand | null = null
  ): void {
    new ToolbarCommandModal(this.app, existing, "command", (cmd) => {
      if (parent) {
        const children = parent.children ?? [];
        parent.children = [...children, cmd];
        this.openSubmenus.add(parent.id);
      } else if (existing && target) {
        const at = target.findIndex((c) => c.id === existing.id);
        if (at >= 0) target[at] = cmd;
      } else if (target) {
        target.push(cmd);
      }
      this.applyToolbarChange();
      this.renderToolbar(host);
    }).open();
  }

  private openSubmenuModal(
    host: HTMLElement,
    target: ToolbarCommand[] | null,
    existing: ToolbarCommand | null,
    asHeading = false
  ): void {
    new ToolbarCommandModal(this.app, existing, asHeading ? "heading" : "submenu", (cmd) => {
      if (existing && target) {
        const at = target.findIndex((c) => c.id === existing.id);
        if (at >= 0) target[at] = cmd;
      } else if (target) {
        // Created open: an empty submenu shows its own hint, and the user is
        // about to fill it in.
        this.openSubmenus.add(cmd.id);
        target.push(cmd);
      }
      this.applyToolbarChange();
      this.renderToolbar(host);
    }).open();
  }

  /**
   * Reads the row order back out of the DOM and writes it to `target`.
   *
   * Rows are matched by command id instead of by their old position: after a
   * drop the array has not been re-rendered, so any position recorded in the
   * markup would already be a step behind. `scope` is the list the rows were
   * dragged inside — the toolbar, or one submenu — so dragging never moves an
   * entry across levels, which the nesting model has no way to express.
   */
  private commitRowOrder(scope: HTMLElement, target: ToolbarCommand[]): void {
    const byId = new Map(target.map((cmd) => [cmd.id, cmd]));
    const ordered: ToolbarCommand[] = [];
    for (const row of Array.from(scope.children)) {
      if (!(row instanceof HTMLElement)) continue;
      const cmd = byId.get(row.dataset.cmdId ?? "");
      if (cmd) ordered.push(cmd);
    }
    // Never let a missing row turn into a silently deleted command.
    if (ordered.length !== target.length) return;
    target.splice(0, target.length, ...ordered);
    this.applyToolbarChange();
  }

  /** Persists a toolbar edit and repaints the bar pinned in the editor. */
  private applyToolbarChange(): void {
    // The new order is already in the list's DOM (settle() inserted it) before
    // this runs, so the release handler must do no heavy work: push both the
    // editor-bar repaint and the settings write onto a later task. That keeps a
    // drop instant, and — importantly — keeps the editor toolbar's re-pin (and
    // its MutationObserver) off the pointerup turn, where a re-render loop in
    // the active editor could otherwise peg the main thread for seconds.
    setTimeout(() => {
      this.plugin.refreshToolbar();
      void this.plugin.saveSettings();
    }, 0);
  }

  /* ------------------------------------------------------------- hiding */

  private renderFileHiding(host: HTMLElement): void {
    // The rule box gets a row of its own: a multi-line writing surface sharing
    // a row with a paragraph collapses to the width of a default textarea.
    new Setting(host)
      .setName(t("settings.hidden.rules.name"))
      .setDesc(t("settings.hidden.rules.desc"))
      .setClass("mtk-setting-stack")
      .addTextArea((area) => {
        area.setValue(this.plugin.settings.hiddenRules);
        area.setPlaceholder(t("settings.hidden.rules.placeholder"));
        area.inputEl.rows = 6;
        area.inputEl.addEventListener("input", () => {
          this.plugin.settings.hiddenRules = area.getValue();
          void this.plugin.refreshHideRules();
        });
      });

    new Setting(host)
      .setName(t("settings.hidden.ignoreCase.name"))
      .setDesc(t("settings.hidden.ignoreCase.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hiddenIgnoreCase).onChange((value) => {
          this.plugin.settings.hiddenIgnoreCase = value;
          void this.plugin.refreshHideRules();
        })
      );

    new Setting(host)
      .setName(t("settings.hidden.enabled.name"))
      .setDesc(t("settings.hidden.enabled.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hiddenEnabled).onChange((value) => {
          this.plugin.settings.hiddenEnabled = value;
          void this.plugin.refreshHideRules();
        })
      );

    new Setting(host)
      .setName(t("settings.hidden.exclude.name"))
      .setDesc(t("settings.hidden.exclude.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hiddenExcludeList).onChange((value) => {
          this.plugin.settings.hiddenExcludeList = value;
          void this.plugin.refreshHideRules();
        })
      );

    new Setting(host)
      .setName(t("settings.hidden.statusBar.name"))
      .setDesc(t("settings.hidden.statusBar.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hiddenStatusBar).onChange((value) => {
          this.plugin.settings.hiddenStatusBar = value;
          void this.plugin.refreshHideRules();
        })
      );

    new Setting(host)
      .setName(t("settings.hidden.ribbon.name"))
      .setDesc(t("settings.hidden.ribbon.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hiddenRibbonButton).onChange((value) => {
          this.plugin.settings.hiddenRibbonButton = value;
          void this.plugin.refreshHideRules();
        })
      );
  }

  /* -------------------------------------------------------------- order */

  private renderFileOrder(host: HTMLElement): void {
    // Cleared for the same reason as the toolbar panel: this is re-rendered in
    // place after the reset below, and appending would duplicate the page.
    // `host` is this tab's whole panel, so clearing it only resets this tab.
    host.replaceChildren();

    new Setting(host)
      .setName(t("settings.order.button.name"))
      .setDesc(t("settings.order.button.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.orderButton).onChange(async (value) => {
          this.plugin.settings.orderButton = value;
          // Hiding the button ends the mode with it. A mode is left by pressing
          // the thing that started it, so one running behind a hidden button
          // could neither be seen nor left — and it would come back the moment
          // the switch was turned on again, filling the tree with handles for
          // no visible reason. The order itself is not touched either way.
          if (!value) this.plugin.settings.orderMode = false;
          // Through the plugin rather than straight to disk: the change has to
          // reach the explorer's toolbar and every handle as well as the file.
          await this.plugin.refreshFileOrder();
        })
      );

    // A row like the toggles above it, rather than a loose paragraph and a
    // loose button: this is the only destructive control on the page, and it
    // reads as the odd one out when it does not line up with the others.
    //
    // The count is the context the button needs — "clear everything" says
    // nothing until you know how much there is — so it becomes the row's
    // description. That also ties the two together: the number cannot drift
    // away from the button it belongs to, because the reset below rebuilds the
    // pair in one go.
    new Setting(host)
      .setName(t("settings.order.reset.name"))
      .setDesc(
        t("settings.order.count", {
          count: Object.keys(this.plugin.settings.orderMap).length,
        })
      )
      .addButton((button) =>
        button.setButtonText(t("settings.order.reset.button")).onClick(() => {
          this.plugin.settings.orderMap = {};
          void this.plugin.refreshFileOrder();
          new Notice(t("settings.order.resetDone"));
          this.renderFileOrder(host);
        })
      );

    // The list of folders whose subfolders were arranged by hand, one row per
    // record. Sorted by path rather than taken in storage order: data.json's
    // key order is insertion order, which reads as arbitrary to anyone who
    // did not make the drags in the same sequence recently.
    const paths = Object.keys(this.plugin.settings.orderMap).sort((a, b) =>
      a.localeCompare(b)
    );

    const list = h("ul", { cls: "mtk-order-list" });
    if (paths.length === 0) {
      list.appendChild(
        h("li", { cls: "mtk-order-empty", text: t("settings.order.listEmpty") })
      );
    } else {
      for (const path of paths) list.appendChild(this.buildOrderRecord(host, path));
    }

    // Two different sentences, so two different elements — the same split the
    // toolbar tab makes: "nothing arranged yet" belongs to the list, "nothing
    // matched what you typed" belongs to the search and takes the list's
    // place for as long as it is true.
    const noMatch = h("p", {
      cls: "mtk-order-search-empty",
      text: t("settings.order.searchEmpty"),
      attr: { hidden: "hidden" },
    });

    // Both rows above the list are always here, empty vault or not: the search
    // box is the tab's own furniture, and a control that appears only once
    // there is something to search makes the page look like it changed shape.
    // The filter itself is what knows there is nothing to match — see
    // `applyOrderFilter`, which is told whether the list has rows at all.
    host.appendChild(this.buildOrderSearch(list, noMatch));
    host.appendChild(list);
    host.appendChild(noMatch);

    this.applyOrderFilter(list, noMatch);
  }

  /**
   * One record of the custom-order list: a header row, and the tree of names
   * that were arranged underneath it.
   *
   * The path is the header's payload — the record holds names of subfolders,
   * but the thing a user recognises and searches for is the folder they dragged
   * in — so it gets the width and a clear button of its own, the single-record
   * way out that the reset row above can only offer for everyone, plus a
   * triangle that opens the names below.
   *
   * The tree hangs *inside* this element rather than beside it, which is what
   * makes one search keystroke hide the whole record: the filter marks this
   * `li`, and hiding it takes the header and every name below it with it. Put
   * the tree next to the row instead and a filtered-out record would leave its
   * names floating on the page.
   *
   * The vault root is stored as `/`, which is exact but reads as a glitch, so
   * it is shown in words; the record itself is untouched.
   */
  private buildOrderRecord(host: HTMLElement, path: string): HTMLElement {
    const label = this.orderLabel(path);
    const record = h("li", { cls: "mtk-order-rec", attr: { "data-path": path } });
    const row = h("div", { cls: "mtk-order-row" });

    row.appendChild(h("span", { cls: "mtk-order-path", text: label }));

    // Right-hand end of the row, in the toolbar's own order: the triangle that
    // opens the list, then the action. Same two boxes the toolbar puts there,
    // which is why a record and a toolbar row read alike at a glance.
    const tree = this.buildOrderTree(path);
    const open = this.expandedOrders.has(path);
    const toggle = h("button", {
      cls: "clickable-icon mtk-order-toggle",
      attr: {
        type: "button",
        "aria-expanded": String(open),
        "aria-controls": tree.id,
        "aria-label": t(open ? "settings.order.row.collapse" : "settings.order.row.expand", {
          path: label,
        }),
      },
    });
    setIcon(toggle, "chevron-right");
    toggle.addEventListener("click", () => this.toggleOrderBranch(path, toggle, tree, label));
    row.appendChild(toggle);

    row.appendChild(
      this.buildIconAction("trash-2", t("settings.order.row.clearAria", { path: label }), "mtk-order-clear", () => {
        delete this.plugin.settings.orderMap[path];
        // Only records are ever opened now that the list is one level, so this
        // is the whole of the forgotten state.
        this.expandedOrders.delete(path);
        void this.plugin.refreshFileOrder();
        new Notice(t("settings.order.row.cleared", { path: label }));
        // A rebuild rather than a row removal: the count in the reset row above
        // belongs to the same record, and the empty state may have arrived.
        this.renderFileOrder(host);
      })
    );

    record.appendChild(row);
    record.appendChild(tree);
    tree.toggleAttribute("hidden", !open);
    return record;
  }

  /**
   * The names one record arranged, in the order it arranged them: one row each,
   * each with a handle that moves it inside this list.
   *
   * One level, deliberately. A recorded name can have a record of its own, and
   * the first version drew that as a tree that opened again one level down —
   * which made rows on the same list mean two different things (a name here, a
   * folder with an order of its own there) and left the reader counting
   * indentation to tell them apart. This list edits one array, so it is one
   * list.
   *
   * The record's array *is* the custom order, so the names are rendered in the
   * order they are stored and nothing sorts them.
   */
  private buildOrderTree(parentPath: string): HTMLElement {
    const tree = h("ul", { cls: "mtk-order-tree" });
    tree.id = `mtk-order-tree-${++this.orderTreeSeq}`;

    const order = this.plugin.settings.orderMap[parentPath] ?? [];
    for (const name of order) tree.appendChild(this.buildOrderRow(tree, parentPath, name));
    return tree;
  }

  /** One arranged name: a handle, and the name it moves. */
  private buildOrderRow(tree: HTMLElement, parentPath: string, name: string): HTMLElement {
    const node = h("li", { cls: "mtk-order-node", attr: { "data-order-name": name } });
    const row = h("div", { cls: "mtk-order-tree-row" });
    row.appendChild(this.buildOrderGrip(tree, node, parentPath, name));

    // A recorded name that is not a folder any more — deleted outside
    // Obsidian, or replaced by a file — is marked rather than dropped. The
    // record is what this tab shows, so hiding the entry would read as a name
    // that went missing from the list instead of one that went missing from the
    // vault; `prune` clears it on the next start.
    row.appendChild(this.buildOrderName(name, this.folderAt(childPath(parentPath, name)) === null));
    node.appendChild(row);
    return node;
  }

  /**
   * The handle that moves one name inside its record's list.
   *
   * `attachRowReorder` is the toolbar's own gesture, reused rather than written
   * again: it is handed the list, the element to move, the handle, a commit,
   * and the `data-` key that marks the rows it may reorder. So this handle has
   * the same drag preview, the same keyboard path (arrow keys), and the same
   * "the order is committed on release, once" as the toolbar's.
   */
  private buildOrderGrip(
    tree: HTMLElement,
    node: HTMLElement,
    parentPath: string,
    name: string
  ): HTMLElement {
    const label = t("settings.order.reorder", { name });
    const grip = h("span", {
      cls: "mtk-order-grip",
      attr: { role: "button", tabindex: "0", "aria-label": label },
    });
    setIcon(grip, "grip-vertical");
    attachRowReorder(tree, node, grip, () => this.commitOrderNames(parentPath, tree), "orderName");
    return grip;
  }

  /**
   * Reads the list's order back out of the DOM and writes it into the record.
   *
   * Matched by name rather than by position, for the toolbar's own reason: the
   * drag has already put the list in the new order by the time this runs, so an
   * index written into the markup beforehand would be a step behind.
   *
   * The write goes through `refreshFileOrder` on a later task, again like the
   * toolbar's commit: the new order is on screen already, and laying the
   * explorer out again must not happen on the pointerup turn.
   */
  private commitOrderNames(parentPath: string, tree: HTMLElement): void {
    const order = this.plugin.settings.orderMap[parentPath];
    if (!order) return;

    const names = [...tree.children]
      .filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && typeof el.dataset.orderName === "string"
      )
      .map((el) => el.dataset.orderName as string);

    // Never let a missing row turn into a silently dropped name.
    if (names.length !== order.length) return;
    order.splice(0, order.length, ...names);
    setTimeout(() => void this.plugin.refreshFileOrder(), 0);
  }

  /** A name, wearing the "this folder is gone" mark when that is what it is. */
  private buildOrderName(name: string, gone: boolean): HTMLElement {
    const span = h("span", { cls: "mtk-order-name", text: name });
    if (gone) {
      span.classList.add("mtk-order-gone");
      span.setAttribute("title", t("settings.order.row.gone"));
    }
    return span;
  }

  /** Opens or closes one branch, and remembers which. */
  private toggleOrderBranch(
    path: string,
    toggle: HTMLElement,
    branch: HTMLElement,
    label: string
  ): void {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute(
      "aria-label",
      t(open ? "settings.order.row.collapse" : "settings.order.row.expand", { path: label })
    );
    branch.toggleAttribute("hidden", !open);
    if (open) this.expandedOrders.add(path);
    else this.expandedOrders.delete(path);
  }

  /** The vault root's stored `/` reads as a glitch, so it is shown in words. */
  private orderLabel(path: string): string {
    return path === ROOT_KEY ? t("settings.order.rootPath") : path;
  }

  /**
   * The folder at `path`, or null when there is something else there.
   *
   * `getAbstractFileByPath` rather than `getFolderByPath`: the shorter call
   * only arrived in Obsidian 1.5.7 and `manifest.minAppVersion` is 1.4.16.
   */
  private folderAt(path: string): TFolder | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
  }

  /**
   * The search row above the custom-order list.
   *
   * Filters in place rather than rebuilding the list — rows are only marked,
   * so the caret stays in the box across a keystroke — and refills from
   * `orderQuery`, so the rebuild a deletion causes hands back the same
   * filtered view the user was reading.
   */
  private buildOrderSearch(list: HTMLElement, noMatch: HTMLElement): HTMLElement {
    // No class of its own: the row is a `Setting` like the ones above it, and
    // app.css already owns how a standard row behaves when the pane is narrow
    // (`@container (max-width: 340px)` stacks it and stretches the control), so
    // a layout rule here would be one more thing to keep in step with it.
    const setting = new Setting(document.createElement("div"))
      .setName(t("settings.order.searchTitle"))
      .setDesc(t("settings.order.searchDesc"));

    const input = h("input", {
      cls: "mtk-toolbar-search-input",
      attr: {
        type: "search",
        spellcheck: "false",
        placeholder: t("settings.order.searchPlaceholder"),
        "aria-label": t("settings.order.searchTitle"),
      },
    });
    input.value = this.orderQuery;
    input.addEventListener("input", () => {
      this.orderQuery = input.value;
      this.applyOrderFilter(list, noMatch);
    });
    setting.controlEl.appendChild(input);
    return setting.settingEl;
  }

  /**
   * Shows only the rows whose folder path contains the query.
   *
   * Each pass answers from scratch — the query and the record's own path,
   * nothing carried over — so clearing the box restores the full list. The path
   * is matched in full, not just the last segment: deep folders are found by
   * the route that leads to them.
   *
   * What is matched is deliberately the record's own path and not the names
   * inside its list: those are hidden until the record is opened, so a hit on
   * one would answer with a record that does not visibly contain what was
   * typed. A record is hidden whole — header and list together — which is why
   * the filter marks the `li` the record is.
   *
   * Whether there is anything to match is read off the list rather than handed
   * in: an empty list is its own state, and a caller passing what it knew at
   * build time is a caller that can be wrong — this used to be a parameter, and
   * the search box's own handler passed `true` unconditionally, so an empty
   * list answered a query with "nothing matched".
   */
  private applyOrderFilter(list: HTMLElement, noMatch: HTMLElement): void {
    const needle = this.orderQuery.trim().toLowerCase();
    const records = Array.from(list.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("mtk-order-rec")
    );
    let visible = 0;
    for (const record of records) {
      const haystack = (record.dataset.path ?? "").toLowerCase();
      const shown = needle.length === 0 || haystack.includes(needle);
      record.classList.toggle("mtk-order-filtered", !shown);
      if (shown) visible += 1;
    }

    // An empty list is not a failed search: its own row already says what to
    // do, and "no match" over it would answer a question nobody asked.
    const none = records.length > 0 && needle.length > 0 && visible === 0;
    list.classList.toggle("is-no-match", none);
    noMatch.toggleAttribute("hidden", !none);
  }

  /* ----------------------------------------------------------- attachment */

  private renderAttachment(host: HTMLElement): void {
    host.appendChild(h("h3", { text: t("settings.attachment.basic.heading") }));

    new Setting(host)
      .setName(t("settings.attachment.folder.name"))
      .setDesc(t("settings.attachment.folder.desc"))
      .addText((text) => {
        text.setPlaceholder("./assets/${noteFileName}");
        text.setValue(this.plugin.settings.attachmentFolder);
        text.onChange(async (value) => {
          this.plugin.settings.attachmentFolder = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(host)
      .setName(t("settings.attachment.template.name"))
      .setDesc(t("settings.attachment.template.desc"))
      .addText((text) => {
        text.setValue(this.plugin.settings.attachmentTemplate);
        text.onChange(async (value) => {
          this.plugin.settings.attachmentTemplate = value;
          await this.plugin.saveSettings();
        });
      });

    // The token help is a text-only option: the variable list lives in its
    // description, with no control. It documents both templates above.
    new Setting(host)
      .setName(t("settings.attachment.variables.name"))
      .setDesc(t("settings.attachment.tokens"));

    // Render order is the on-screen order: basic → modification → deletion →
    // special chars. Special characters sits last because it is the most rarely
    // touched knob.
    this.renderModification(host);
    this.renderDeletion(host);
    this.renderSpecialCharacters(host);
  }

  /**
   * The "Modification" block: what happens to attachments that already exist when
   * the note they belong to is renamed or moved.
   */
  private renderModification(host: HTMLElement): void {
    host.appendChild(h("h3", { text: t("settings.attachment.modification.heading") }));

    new Setting(host)
      .setName(t("settings.attachment.syncRename.name"))
      .setDesc(t("settings.attachment.syncRename.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAttachmentsOnRename)
          .onChange(async (value) => {
            this.plugin.settings.syncAttachmentsOnRename = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(host)
      .setName(t("settings.attachment.syncMove.name"))
      .setDesc(t("settings.attachment.syncMove.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAttachmentsOnMove)
          .onChange(async (value) => {
            this.plugin.settings.syncAttachmentsOnMove = value;
            await this.plugin.saveSettings();
          })
      );

    // Duplicate-name separator. The quoted file names in the description are
    // rebuilt on every keystroke, so the example always shows what the next save
    // will actually produce — which is also the only way to see a separator that
    // is invisible in the input (a space).
    const exampleName = "existingFile.pdf";
    const exampleBase = stripExtension(exampleName);
    const exampleExt = exampleName.slice(exampleBase.length);
    const example = noteLineWithCodes("settings.attachment.duplicateSeparator.desc2", {
      original: exampleName,
    });
    const duplicateLines = h("div", { cls: "mtk-note-lines" });
    duplicateLines.appendChild(
      h("div", {
        cls: "mtk-settings-note",
        text: t("settings.attachment.duplicateSeparator.desc1"),
      })
    );
    duplicateLines.appendChild(example.line);
    const duplicateDesc = document.createDocumentFragment();
    duplicateDesc.appendChild(duplicateLines);

    const refreshExample = (): void => {
      const separator = resolveDuplicateSeparator(
        this.plugin.settings.attachmentDuplicateSeparator,
        {
          chars: this.plugin.settings.attachmentSpecialChars,
          replacement: this.plugin.settings.attachmentSpecialCharsReplacement,
        }
      );
      const first = example.codes.get("first");
      const second = example.codes.get("second");
      if (first) first.textContent = `${exampleBase}${separator}1${exampleExt}`;
      if (second) second.textContent = `${exampleBase}${separator}2${exampleExt}`;
    };
    refreshExample();

    new Setting(host)
      .setName(t("settings.attachment.duplicateSeparator.name"))
      .setDesc(duplicateDesc)
      .addText((text) => {
        text.setValue(this.plugin.settings.attachmentDuplicateSeparator);
        text.onChange(async (value) => {
          this.plugin.settings.attachmentDuplicateSeparator = value;
          refreshExample();
          await this.plugin.saveSettings();
        });
      });
  }

  /**
   * The "Special characters" block: which characters are unwelcome in generated
   * attachment folder / file names, and what takes their place.
   *
   * Both inputs treat empty as meaningful — an empty character list keeps every
   * character, an empty replacement deletes the ones that matched.
   */
  private renderSpecialCharacters(host: HTMLElement): void {
    host.appendChild(h("h3", { text: t("settings.attachment.specialChars.heading") }));

    new Setting(host)
      .setName(t("settings.attachment.specialChars.name"))
      .setDesc(
        noteLines(
          "settings.attachment.specialChars.desc1",
          "settings.attachment.specialChars.desc2"
        )
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.attachmentSpecialChars);
        text.onChange(async (value) => {
          this.plugin.settings.attachmentSpecialChars = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(host)
      .setName(t("settings.attachment.specialCharsReplacement.name"))
      .setDesc(
        noteLines(
          "settings.attachment.specialCharsReplacement.desc1",
          "settings.attachment.specialCharsReplacement.desc2"
        )
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.attachmentSpecialCharsReplacement);
        text.onChange(async (value) => {
          this.plugin.settings.attachmentSpecialCharsReplacement = value;
          await this.plugin.saveSettings();
        });
      });
  }

  /**
   * The "Deletion" block, modeled after attachment-management's settings:
   * what happens to emptied attachment folders, and whether deleting a note
   * also sweeps the attachments it orphaned. Everything is preference-driven —
   * there are no manual cleanup buttons here.
   */
  private renderDeletion(host: HTMLElement): void {
    host.appendChild(h("h3", { text: t("settings.attachment.deletion.heading") }));

    // Same flush-line treatment as `noteLines`, but each line leads with the
    // option name in bold rather than a plain i18n string.
    const emptyLines = h("div", { cls: "mtk-note-lines" });
    for (const opt of EMPTY_FOLDER_OPTIONS) {
      const line = h("div", { cls: "mtk-settings-note" });
      const name = document.createElement("strong");
      name.textContent = t(opt.labelKey);
      line.appendChild(name);
      line.appendChild(document.createTextNode(` - ${t(opt.descKey)}`));
      emptyLines.appendChild(line);
    }
    const emptyDesc = document.createDocumentFragment();
    emptyDesc.appendChild(emptyLines);

    new Setting(host)
      .setName(t("settings.attachment.emptyFolder.name"))
      .setDesc(emptyDesc)
      .addDropdown((drop) => {
        for (const opt of EMPTY_FOLDER_OPTIONS) {
          drop.addOption(opt.value, t(opt.labelKey));
        }
        drop.setValue(this.plugin.settings.emptyFolderHandling);
        drop.onChange(async (value) => {
          if (value === "keep" || value === "delete" || value === "delete-and-parents") {
            this.plugin.settings.emptyFolderHandling = value;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(host)
      .setName(t("settings.attachment.deleteOrphan.name"))
      .setDesc(t("settings.attachment.deleteOrphan.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteOrphanedOnNoteDelete)
          .onChange(async (value) => {
            this.plugin.settings.deleteOrphanedOnNoteDelete = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

/**
 * Multi-line setting description: one note-styled line per key, so the wording
 * can carry a second sentence without turning into a wall of text.
 *
 * The lines live in a `.mtk-note-lines` wrapper, which cancels the blank row a
 * standalone `.mtk-settings-note` reserves below itself.
 */
function noteLines(...keys: string[]): DocumentFragment {
  const wrap = h("div", { cls: "mtk-note-lines" });
  for (const key of keys) {
    wrap.appendChild(h("div", { cls: "mtk-settings-note", text: t(key) }));
  }
  const frag = document.createDocumentFragment();
  frag.appendChild(wrap);
  return frag;
}

/**
 * One note-styled line whose `{{placeholders}}` render as inline `<code>` spans —
 * for descriptions that quote literal file names.
 *
 * The spans come back alongside the line so a caller can keep the example in
 * step with the setting it describes.
 */
function noteLineWithCodes(
  key: string,
  values: Record<string, string>
): { line: HTMLElement; codes: Map<string, HTMLElement> } {
  const line = h("div", { cls: "mtk-settings-note" });
  const codes = new Map<string, HTMLElement>();
  const template = t(key);
  const placeholder = /\{\{(\w+)\}\}/g;
  let cursor = 0;
  for (
    let match = placeholder.exec(template);
    match;
    match = placeholder.exec(template)
  ) {
    line.appendChild(document.createTextNode(template.slice(cursor, match.index)));
    const code = h("code", { text: values[match[1]] ?? "" });
    codes.set(match[1], code);
    line.appendChild(code);
    cursor = match.index + match[0].length;
  }
  line.appendChild(document.createTextNode(template.slice(cursor)));
  return { line, codes };
}

/**
 * Full literal keys (not interpolated) so the i18n checker can verify them.
 * Order is also the order they appear in the dropdown.
 */
const EMPTY_FOLDER_OPTIONS: {
  value: EmptyFolderHandling;
  labelKey: string;
  descKey: string;
}[] = [
  {
    value: "keep",
    labelKey: "settings.attachment.emptyFolder.optKeep",
    descKey: "settings.attachment.emptyFolder.optKeepDesc",
  },
  {
    value: "delete",
    labelKey: "settings.attachment.emptyFolder.optDelete",
    descKey: "settings.attachment.emptyFolder.optDeleteDesc",
  },
  {
    value: "delete-and-parents",
    labelKey: "settings.attachment.emptyFolder.optDeleteParents",
    descKey: "settings.attachment.emptyFolder.optDeleteParentsDesc",
  },
];

/**
 * Makes one row draggable by its handle.
 *
 * Pointer events rather than HTML5 drag-and-drop: the settings tab is reachable
 * on touch, where `dragstart` never fires. The handle is focusable as well, so
 * the order can also be changed with the arrow keys when there is no pointer.
 *
 * `moved` is the element the list reorders — the row's own `<li>`, or a
 * submenu's wrapping `<li>` rather than the header `<div>` inside it. Which one
 * matters: the header is not a child of the list, so re-inserting it there would
 * tear the submenu apart.
 *
 * Dragging is confined to one list. A submenu's rows live inside the same `<li>`
 * as its header, so a `querySelectorAll` would pull them into a top-level drag
 * and move them across levels — a move the model has no way to write down.
 *
 * What moves is the row itself. Floating a copy of the row after the pointer
 * reads well, but it puts the thing the user is watching into a coordinate
 * space and a layer of its own — and the app shell, the theme or a stylesheet
 * that has fallen a version behind can take either away, none of which the
 * plugin can see from inside. Leaving the row in place keeps every number this
 * feature depends on inside the list.
 *
 * While the pointer is down, the list is not touched at all. Re-inserting a row
 * detaches and re-attaches the element the gesture started on, and a host that
 * notices — Chromium does, and cancels the pointer for it — takes the rest of
 * the gesture with it: the row is seen to be picked up, and then nothing.
 * Instead the rows are drawn where they would end up, using `transform` only,
 * and the list is put into that order once, on release. One change per drag,
 * made after the pointer is up, is a change nothing can interrupt.
 *
 * That is also why the listeners hang off the window, in the capture phase: the
 * gesture has to outlive anything the app does between the row and the window,
 * and it must not be held up by an element the drag is free to move.
 */
/** Reorder timings. The landing pulse in styles.css matches `REORDER_PULSE_MS`. */
const REORDER_EASE = "cubic-bezier(.22,.75,.28,1)";
const REORDER_SLIDE_MS = 180;
const REORDER_PULSE_MS = 240;

/**
 * Added to the row the user is dragging. What the lift looks like lives in the
 * stylesheet, so a stylesheet that predates this class costs the look and
 * nothing else: the row stays visible, stays its own size and stays in the
 * list either way.
 */
const DRAG_LIFT = "is-drag-lift";

/** True when the OS asks for less motion; the reorder animations are then skipped. */
function reduceMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * How the gesture's listeners are registered: at the window, in the capture
 * phase, and identically on the way out.
 *
 * Capture, because every handler between the row and the window gets to run
 * before a bubble-phase listener on the window does, and one of them calling
 * `stopPropagation` would end the drag at the first move — a failure that looks
 * exactly like a drag that never started. Capture runs first and cannot be cut
 * off from below.
 */
const DRAG_LISTENER: AddEventListenerOptions = { capture: true };

/**
 * Attaches the reorder gesture to one handle.
 *
 * `rowKey` names the `data-` attribute that marks a list's reorderable rows, so
 * the same gesture serves both lists that have one: the toolbar's rows are
 * marked by command id, and a record's names by name. Matching on a key rather
 * than on position is what lets the drag survive the DOM being put in the order
 * the preview showed — the commit runs after the move, and any index written
 * into the markup beforehand would already be a step behind.
 */
function attachRowReorder(
  list: HTMLElement,
  moved: HTMLElement,
  grip: HTMLElement,
  commit: () => void,
  rowKey: string
): void {
  const rows = (): HTMLElement[] =>
    Array.from(list.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && typeof el.dataset[rowKey] === "string"
    );

  /**
   * Ends any reorder animation a row is still playing, so the next measurement
   * reads a settled layout.
   *
   * The slides below (and the keyboard path that drives them) can overlap a
   * gesture that starts before they finish; measuring mid-flight would make
   * each slide's distance depend on the previous one.
   */
  const settledRect = (row: HTMLElement): DOMRect => {
    for (const anim of row.getAnimations()) {
      if (anim.playState === "running") anim.finish();
    }
    return row.getBoundingClientRect();
  };

  /**
   * Runs `place`, then slides every row that ended up somewhere else.
   *
   * This is the arrow keys' path, where there is no pointer to interrupt and
   * the list can simply be changed: re-inserting a row teleports it, so where
   * each row was is remembered, the move is allowed to happen, and the
   * difference is played back as a transform — which turns the teleport into a
   * slide. The dragged row is one of the rows read here, so it is the one that
   * visibly travels, while the rows it passed slide the other way. `items`
   * holds element references, so the array still lines up with `before` after
   * the move reorders the DOM.
   *
   * A pointer drag does not come through here; it draws a preview and changes
   * the list once, on release.
   */
  const slide = (place: () => void): void => {
    const items = rows();
    const before = items.map((row) => settledRect(row).top);
    place();
    const duration = reduceMotion() ? 0 : REORDER_SLIDE_MS;
    items.forEach((row, index) => {
      const dy = before[index] - row.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) return;
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration,
        easing: REORDER_EASE,
      });
    });
  };

  const step = (delta: -1 | 1): void => {
    const all = rows();
    const at = all.indexOf(moved);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= all.length) return;
    // Downward moves land after the neighbour, upward moves land before it.
    slide(() => list.insertBefore(moved, delta < 0 ? all[to] : all[to].nextSibling));
    commit();
  };

  grip.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") step(-1);
    else if (event.key === "ArrowDown") step(1);
    else return;
    event.preventDefault();
  });

  /*
   * A native drag would hand the gesture to the OS and the row would stop
   * following anything, so the one the browser would start here is refused.
   */
  grip.addEventListener("dragstart", (event) => event.preventDefault());

  grip.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    // Keeps the press from selecting the row's text or scrolling the panel.
    event.preventDefault();

    const pressed = rows();
    const from = pressed.indexOf(moved);
    if (from < 0) return;
    const pointerId = event.pointerId;

    // Bind every pointer event of this gesture to the grip, so the drag keeps
    // tracking wherever the cursor goes — over the list, over the panel's empty
    // space, or outside the settings panel. Without capture, a nested settings
    // panel that handles its own pointer events can swallow the moves while the
    // cursor is inside it, which reads as "the row only moves once the mouse
    // leaves the panel".
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort; the grip listeners below still receive events */
    }

    /*
     * Everything the gesture needs is measured once, from settled layout, in
     * the pointer's own coordinate space: `getBoundingClientRect()` and
     * `PointerEvent.clientY` answer in the same viewport pixels, so their
     * agreement survives whatever sits between the list and the window — a
     * scrolled panel, a positioned ancestor, or a zoomed page (Obsidian's UI
     * zoom scales the page without scaling `offsetTop`/`offsetHeight`, which
     * report unscaled layout pixels; mixing the two spaces is what made a
     * zoomed-out panel's drags land short or not at all). A transform does not
     * move layout, so these numbers stay true however far the rows are drawn
     * from where they are — which is what lets the preview be a function of
     * the pointer alone. Reading back what is on screen instead would feed
     * each frame into the next, and a fast drag would swap rows it should not.
     */
    let listTop = list.getBoundingClientRect().top;
    // The list box is stable while a row is dragged (only the rows transform),
    // so its viewport top is cached and reused every frame instead of forcing a
    // layout flush per move. A panel scroll mid-drag would shift it, so a scroll
    // listener invalidates the cache lazily: only the frame after a scroll pays
    // for one re-read, which keeps the gesture off the layout critical path.
    let listScrolled = false;
    const onListScroll = (): void => {
      listScrolled = true;
    };
    window.addEventListener("scroll", onListScroll, { capture: true });
    const boxes = pressed.map((row) => settledRect(row));
    const slot = boxes.map((box) => box.top - listTop);
    const height = boxes.map((box) => box.height);
    // Where inside the dragged row the pointer went down, and how far it may be
    // drawn before it would have to leave the list — used to glue the row to the
    // pointer without letting a fast fling clip it past the first or last slot.
    const grabTop = event.clientY - boxes[from].top;
    const minDy = -(slot[from] - slot[0]);
    const maxDy = slot[pressed.length - 1] - slot[from];
    const original = new Map(pressed.map((row, index) => [row, index]));
    const rest = pressed.filter((row) => row !== moved);
    let at = from;

    /*
     * The slot `moved` would sit in if the pointer came up now: the number of
     * other rows whose midpoint is above the pointer. Counted rather than
     * searched, because the count is the same question asked in a way that
     * cannot see the preview and start chasing it.
     */
    const slotFor = (clientY: number, origin: number): number => {
      let count = 0;
      for (let i = 0; i < pressed.length; i++) {
        if (i === from) continue;
        if (clientY > origin + slot[i] + height[i] / 2) count++;
      }
      return count;
    };

    /*
     * Draws the order the list is going to be put in, without putting it in
     * that order: the rows are laid out top to bottom in the new sequence, and
     * each is told the distance from where it belongs to where it still is. The
     * stylesheet turns that distance into a slide, so the dragged row appears
     * to travel to its slot while the rows it passes appear to move out of its
     * way — and the list's own children never change.
     */
    const paint = (next: number, clientY: number, origin: number): void => {
      at = next;
      const sequence = rest.slice(0, at).concat(moved, rest.slice(at));
      let y = origin + slot[0];
      for (const row of sequence) {
        const i = original.get(row) ?? 0;
        let dy: number;
        if (row === moved) {
          // The row in hand tracks the pointer one-to-one (clamped to the list
          // span so a fast fling cannot draw it outside the list and clip it),
          // so the gesture reads as holding the row, not as a lagging preview.
          dy = clientY - grabTop - (origin + slot[from]);
          if (dy < minDy) dy = minDy;
          else if (dy > maxDy) dy = maxDy;
        } else {
          dy = y - (origin + slot[i]);
        }
        if (Math.abs(dy) < 0.5) row.style.removeProperty("transform");
        else row.style.transform = "translateY(" + dy + "px)";
        y += height[i];
      }
    };

    /** Hands every row back to the list. The list is about to place it itself. */
    const unpaint = (): void => {
      for (const row of pressed) row.style.removeProperty("transform");
    };

    const onMove = (moveEvent: PointerEvent): void => {
      // A second pointer — a second finger, a pen — has no business steering
      // the row the first one picked up.
      if (moveEvent.pointerId !== pointerId) return;
      // Re-read the cached list top only after a scroll, so a normal drag does
      // zero layout flushes per frame while a scrolled one stays correct.
      if (listScrolled) {
        listTop = list.getBoundingClientRect().top;
        listScrolled = false;
      }
      const next = slotFor(moveEvent.clientY, listTop);
      // Repaint on every move: the held row must stay glued to the pointer each
      // frame, while the rows it passes slide aside only when the slot changes.
      paint(next, moveEvent.clientY, listTop);
    };

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      grip.removeEventListener("pointermove", onMove, DRAG_LISTENER);
      grip.removeEventListener("pointerup", settle, DRAG_LISTENER);
      grip.removeEventListener("pointercancel", settle, DRAG_LISTENER);
      window.removeEventListener("blur", settle);
      window.removeEventListener("scroll", onListScroll, { capture: true });
      try {
        grip.releasePointerCapture(pointerId);
      } catch {
        /* capture is released automatically on pointer up */
      }

      /*
       * The one and only change to the list, made with the pointer already up:
       * the children are put into the order the preview has been showing, so
       * they land exactly where they were already drawn. A cancelled pointer
       * commits too — the preview is what the user asked for, and reverting it
       * would be the more surprising of the two.
       */
      unpaint();
      if (at !== from) {
        list.insertBefore(moved, rest[at] ?? null);
        // The order is settled the instant the pointer comes up. The model is
        // written before the pulse starts, so a dropped save stays a real bug
        // while a skipped pulse is only a missed flourish.
        commit();
      }
      list.classList.remove("is-reordering");
      moved.classList.remove(DRAG_LIFT);
      // A press that never moved anything is a click, and a click is not worth
      // a flourish.
      if (at === from || reduceMotion()) return;
      moved.classList.add("is-landed");
      window.setTimeout(() => moved.classList.remove("is-landed"), REORDER_PULSE_MS + 120);
    };

    moved.classList.add(DRAG_LIFT);
    list.classList.add("is-reordering");
    // Register the gesture listeners on the grip, which now holds the pointer
    // capture: with capture, every pointermove/pointerup/pointercancel of this
    // gesture is delivered to the grip even when the cursor is over the nested
    // settings panel or outside the window — so the row keeps tracking inside
    // the panel instead of only when the mouse leaves it. (blur stays on window
    // because a lost focus is not a pointer event.)
    grip.addEventListener("pointermove", onMove, DRAG_LISTENER);
    grip.addEventListener("pointerup", settle, DRAG_LISTENER);
    grip.addEventListener("pointercancel", settle, DRAG_LISTENER);
    window.addEventListener("blur", settle);
  });
}

/**
 * Modal for adding or editing a single toolbar entry.
 *
 * A command's id is chosen from the app's command palette through a fuzzy
 * picker; label and icon are pre-filled from the command and stay editable.
 * A submenu has no command to run, so it offers a name and an icon and nothing
 * else — which is also why its name has to be typed rather than fall back to a
 * command name the way every other entry does.
 */
/**
 * What the toolbar-entry dialog is editing.
 *
 * Three shapes rather than a boolean, because a section heading is not a
 * submenu: it has no icon to draw and no children to hold, and offering both
 * fields would be offering controls that do nothing.
 */
export type ToolbarCommandMode = "command" | "submenu" | "heading";

export class ToolbarCommandModal extends Modal {
  private readonly existing: ToolbarCommand | null;
  private readonly mode: ToolbarCommandMode;
  private readonly onSave: (cmd: ToolbarCommand) => void;
  private commandId = "";
  private labelEl: HTMLInputElement | null = null;
  private iconEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    existing: ToolbarCommand | null,
    mode: ToolbarCommandMode,
    onSave: (cmd: ToolbarCommand) => void
  ) {
    super(app);
    this.existing = existing;
    this.mode = mode;
    this.onSave = onSave;
    if (existing) {
      this.commandId = existing.commandId;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: this.title() }));

    // Command id picker
    if (this.mode === "command") {
      const idRow = h("div", { cls: "mtk-field" });
      idRow.appendChild(h("label", { cls: "mtk-field-label", text: t("settings.toolbar.commandId") }));
      const idBtn = h("button", {
        cls: "mtk-btn mtk-btn-pick",
        text: this.existing ? this.commandId : t("settings.toolbar.pick"),
        attr: { type: "button" },
      });
      idBtn.addEventListener("click", () => {
        const picker = new CommandPickerModal(this.app, (command) => {
          this.commandId = command.id;
          idBtn.textContent = command.id;
          // Only the first pick pre-fills: rewriting a label the user typed while
          // changing the command would throw their wording away.
          if (!this.existing) {
            if (this.labelEl) this.labelEl.value = command.name;
            applyIcon(command.icon ?? "command");
          }
        });
        picker.open();
      });
      idRow.appendChild(idBtn);
      contentEl.appendChild(idRow);
    }

    const labelRow = h("div", { cls: "mtk-field" });
    labelRow.appendChild(h("label", { cls: "mtk-field-label", text: t("settings.toolbar.label") }));
    const labelInput = h("input", {
      cls: "mtk-input",
      attr: { type: "text", placeholder: t("settings.toolbar.labelPlaceholder") },
    }) as HTMLInputElement;
    labelInput.value = this.existing?.label ?? "";
    this.labelEl = labelInput;
    labelRow.appendChild(labelInput);
    contentEl.appendChild(labelRow);

    // Icon: a live preview that opens the picker, plus the raw name for anyone
    // who would rather paste one in. Both stay in step.
    const iconRow = h("div", { cls: "mtk-field" });
    iconRow.appendChild(h("label", { cls: "mtk-field-label", text: t("settings.toolbar.icon") }));
    const iconField = h("div", { cls: "mtk-icon-field" });

    const iconPreview = h("button", {
      cls: "clickable-icon mtk-icon-preview",
      attr: { type: "button", "aria-label": t("settings.toolbar.pickIcon") },
    });
    applyTooltip(iconPreview, t("settings.toolbar.pickIcon"));

    const iconInput = h("input", {
      cls: "mtk-input",
      attr: { type: "text", placeholder: "command" },
    }) as HTMLInputElement;
    iconInput.value = this.existing?.icon ?? (this.mode === "submenu" ? "menu" : "");
    this.iconEl = iconInput;

    const applyIcon = (icon: string): void => {
      iconInput.value = icon;
      setIcon(iconPreview, icon.trim() || "command");
    };
    applyIcon(iconInput.value);

    iconInput.addEventListener("input", () => applyIcon(iconInput.value));
    iconPreview.addEventListener("click", () => {
      new IconPickerModal(this.app, iconInput.value.trim(), applyIcon).open();
    });

    iconField.appendChild(iconPreview);
    iconField.appendChild(iconInput);
    iconRow.appendChild(iconField);
    // A heading has nothing to draw an icon on, so it is not offered one.
    if (this.mode !== "heading") contentEl.appendChild(iconRow);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", {
      cls: "mtk-btn",
      text: t("settings.toolbar.cancel"),
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const save = h("button", {
      cls: "mtk-btn mtk-btn-primary",
      text: t("settings.toolbar.save"),
      attr: { type: "button" },
    });
    save.addEventListener("click", () => {
      const label = this.labelEl?.value?.trim() ?? "";
      const icon = this.iconEl?.value?.trim() || "command";
      // A submenu and a heading have nothing to fall back to, so an unnamed one
      // would be a button with no tooltip at all.
      if (this.mode !== "command" && !label) {
        new Notice(t("settings.toolbar.noLabel"));
        return;
      }
      if (this.mode === "command" && !this.commandId) {
        new Notice(t("settings.toolbar.noCommand"));
        return;
      }

      const cmd: ToolbarCommand =
        this.mode === "heading"
          ? // A heading carries a title and nothing else: no command to run, no
            // icon to draw. `icon` is pinned to "" rather than kept from the
            // dialog, which has no icon field in this mode.
            {
              id: this.existing?.id ?? `cmd-${Date.now().toString(36)}`,
              commandId: "",
              label,
              icon: "",
              groupLabel: true,
            }
          : this.mode === "submenu"
            ? // Spread first: an edited submenu keeps its id and its children.
              { ...(this.existing ?? { id: `cmd-${Date.now().toString(36)}`, commandId: "" }), label, icon }
            : {
                id: this.existing?.id ?? `cmd-${Date.now().toString(36)}`,
                commandId: this.commandId,
                label: label || this.commandId,
                icon,
              };
      this.onSave(cmd);
      this.close();
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    contentEl.appendChild(actions);
  }

  private title(): string {
    if (this.mode === "heading") {
      return this.existing ? t("settings.toolbar.editGroupLabel") : t("settings.toolbar.addGroupLabel");
    }
    if (this.mode === "submenu") {
      return this.existing ? t("settings.toolbar.editSubmenu") : t("settings.toolbar.addSubmenu");
    }
    return this.existing ? t("settings.toolbar.edit") : t("settings.toolbar.add");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Fuzzy picker over every command the app knows about. */
class CommandPickerModal extends FuzzySuggestModal<Command> {
  private readonly onChoose: (command: Command) => void;

  constructor(app: App, onChoose: (command: Command) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(t("settings.toolbar.pickPlaceholder"));
  }

  getItems(): Command[] {
    // `app.commands` is an internal API not exposed in Obsidian's public d.ts.
    return (this.app as any).commands?.listCommands() ?? [];
  }

  getItemText(command: Command): string {
    return command.name;
  }

  onChooseItem(command: Command): void {
    this.onChoose(command);
  }
}

/*
 * The icons the picker opens on, in the order they are shown.
 *
 * Obsidian registers around two thousand of them, most of which nobody wants —
 * a wall of every icon it can draw is not a choice, it is a search problem. These
 * are the ones that suit a toolbar button; typing in the box searches the lot.
 */
const ICON_SHORTLIST: string[] = [
  "pencil", "pen-line", "highlighter", "eraser", "type",
  "heading-1", "heading-2", "heading-3", "bold", "italic",
  "underline", "strikethrough", "list", "list-ordered", "list-checks",
  "check", "check-square", "quote", "code", "code-2",
  "terminal", "link", "paperclip", "image", "table",
  "calendar", "clock", "star", "heart", "bookmark",
  "tag", "folder", "file-text", "search", "settings",
  "wrench", "zap", "sparkles", "wand-2", "palette",
  "copy", "scissors", "undo-2", "redo-2", "save",
  "upload", "download", "share-2", "mail", "message-square",
  "bell", "user", "users", "eye", "lock",
  "key", "trash-2", "plus", "minus", "x",
  "arrow-up", "arrow-down", "arrow-left", "arrow-right", "chevron-up",
  "chevron-down", "more-horizontal", "menu", "layout-grid", "move",
  "maximize", "minimize", "refresh-cw", "play", "pause",
  "square", "circle", "triangle", "hexagon", "activity",
  "bar-chart-2", "line-chart", "pie-chart", "git-branch", "git-merge",
  "workflow", "network",
];

/** How many search results are drawn at once. */
const ICON_RESULT_LIMIT = 300;

/**
 * A grid of icons to choose from.
 *
 * The names come from `getIconIds()`, so every cell is something Obsidian can
 * actually draw. A typed name that does not exist fails silently — `setIcon`
 * leaves an empty `<svg>` behind and there is no way to tell that from a
 * styling problem, which is why this is a picker rather than a text box.
 */
class IconPickerModal extends Modal {
  private readonly current: string;
  private readonly onChoose: (icon: string) => void;
  private grid: HTMLElement | null = null;
  private hint: HTMLElement | null = null;

  constructor(app: App, current: string, onChoose: (icon: string) => void) {
    super(app);
    this.current = current;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: t("settings.toolbar.iconPick") }));

    const search = h("input", {
      cls: "mtk-input",
      attr: { type: "search", placeholder: t("settings.toolbar.iconSearch") },
    }) as HTMLInputElement;

    this.grid = h("div", { cls: "mtk-icon-grid" });
    this.hint = h("p", { cls: "mtk-settings-note mtk-icon-hint" });

    search.addEventListener("input", () => this.render(search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const first = this.grid?.querySelector<HTMLElement>(".mtk-icon-cell");
      const icon = first?.dataset.icon;
      if (!icon) return;
      this.onChoose(icon);
      this.close();
    });

    contentEl.appendChild(search);
    contentEl.appendChild(this.grid);
    contentEl.appendChild(this.hint);

    this.render("");
    // The box is the point of the dialog, so it starts focused and the first
    // keystroke searches instead of being swallowed.
    window.setTimeout(() => search.focus(), 0);
  }

  private render(query: string): void {
    if (!this.grid) return;
    this.grid.replaceChildren();

    const registered = new Set<string>(getIconIds());
    const needle = query.trim().toLowerCase();
    const searching = needle.length > 0;
    const matches = searching
      ? [...registered].filter((id) => id.toLowerCase().includes(needle)).sort()
      : ICON_SHORTLIST.filter((id) => registered.has(id));
    const shown = matches.slice(0, ICON_RESULT_LIMIT);

    for (const id of shown) {
      const cell = h("button", {
        cls: "clickable-icon mtk-icon-cell",
        attr: { type: "button", "aria-label": id, "data-icon": id },
      });
      if (id === this.current) cell.classList.add("is-active");
      setIcon(cell, id);
      applyTooltip(cell, id);
      cell.addEventListener("click", () => {
        this.onChoose(id);
        this.close();
      });
      this.grid.appendChild(cell);
    }

    if (!this.hint) return;
    if (matches.length === 0) {
      this.hint.textContent = t("settings.toolbar.iconNone");
    } else if (searching && matches.length > shown.length) {
      this.hint.textContent = t("settings.toolbar.iconMore", {
        count: String(matches.length - shown.length),
      });
    } else if (!searching) {
      this.hint.textContent = t("settings.toolbar.iconHint", {
        count: String(registered.size),
      });
    } else {
      this.hint.textContent = "";
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
