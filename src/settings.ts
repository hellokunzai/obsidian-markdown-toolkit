import {
  PluginSettingTab,
  Setting,
  App,
  Modal,
  FuzzySuggestModal,
  Notice,
  getIconIds,
  setIcon,
  type Command,
} from "obsidian";
import { t } from "./i18n";
import { h } from "./utils/dom";
import { applyTooltip } from "./utils/tooltip";
import { commandName } from "./utils/commands";
import { DIAGRAM_KINDS } from "./core/kinds";
import {
  defaultToolbarCommands,
  isGroupLabel,
  isSubmenu,
  type ToolbarCommand,
} from "./core/toolbar-commands";
import type { EmptyFolderHandling } from "./features/attachment-paths";
import { resolveDuplicateSeparator, stripExtension } from "./features/attachment-paths";
import type { FlowDirection, MindmapLayout } from "./core/model";
import type { Orders } from "./features/order-store";
import type MarkdownEditorPlusPlugin from "./main";
import type { IFeatureFolderEncryptSettings, IMarkedFolder } from "./features/encryption/features/feature-folder-encrypt/IFeatureFolderEncryptSettings";
import type { IFeatureRandomPasswordSettings } from "./features/encryption/features/feature-random-password/IFeatureRandomPasswordSettings";
import { SessionPasswordService } from "./features/encryption/services/SessionPasswordService";

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

export interface MarkdownEditorPlusSettings {
  flowDirection: FlowDirection;
  mindmapLayout: MindmapLayout;
  persistPositions: boolean;
  openIn: "modal" | "tab";

  // ---- New editor-explorer features (0.4.0) ----
  /** Commands shown in the editor toolbar, in display order. */
  toolbarCommands: ToolbarCommand[];
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

  // ---- File encryption (ported from obsidian-vault-encrypted, scheme A) ----
  /** Require the password to be typed twice and confirmed when setting one. */
  confirmPassword: boolean;
  /** Keep entered passwords in memory (cleared on timeout) instead of asking. */
  rememberPassword: boolean;
  /** How long (minutes) a remembered password stays in memory before expiring. */
  rememberPasswordTimeout: number;
  /** Folder encryption: recursive flag plus the list of marked folders. */
  featureFolderEncrypt: IFeatureFolderEncryptSettings;
  /** Random-password generator preferences. */
  featureRandomPassword: IFeatureRandomPasswordSettings;
}

export const DEFAULT_SETTINGS: MarkdownEditorPlusSettings = {
  flowDirection: "TD",
  mindmapLayout: "right",
  persistPositions: true,
  openIn: "modal",

  // Ported from the reference plugin's own default list; see
  // `core/toolbar-commands.ts` for what carried over and what did not.
  toolbarCommands: defaultToolbarCommands(),
  // The dotfiles rule the regular-expression version shipped as its default,
  // said again in the syntax that replaced it.
  hiddenRules: "startsWith::.",
  hiddenEnabled: true,
  hiddenIgnoreCase: true,
  hiddenExcludeList: false,
  hiddenStatusBar: false,
  hiddenExcludeEntries: [],
  orderButton: false,
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
  deleteOrphanedOnNoteDelete: false,

  // ---- File encryption (ported from obsidian-vault-encrypted, scheme A) ----
  confirmPassword: true,
  rememberPassword: true,
  rememberPasswordTimeout: 30,
  featureFolderEncrypt: { recursive: true, markedFolders: [] },
  featureRandomPassword: { length: 16, upper: true, lower: true, number: true, symbol: true },
};

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

  constructor(app: App, plugin: MarkdownEditorPlusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const tabBar = h("div", { cls: "mtk-tabs" });
    const panelHost = h("div", { cls: "mtk-tab-panels" });
    containerEl.appendChild(tabBar);
    containerEl.appendChild(panelHost);

    const tabs: Array<{ id: string; label: string; render: (host: HTMLElement) => void }> = [
      { id: "general", label: t("settings.tab.general"), render: (host) => this.renderGeneral(host) },
      { id: "toolbar", label: t("settings.tab.toolbar"), render: (host) => this.renderToolbar(host) },
      { id: "files", label: t("settings.tab.files"), render: (host) => this.renderFiles(host) },
      { id: "attachment", label: t("settings.tab.attachment"), render: (host) => this.renderAttachment(host) },
      { id: "encryption", label: t("settings.tab.encryption"), render: (host) => this.renderEncryption(host) },
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
    };

    tabs.forEach((tab, index) => {
      const btn = h("button", {
        cls: "mtk-tab settings-tab" + (index === 0 ? " is-active" : ""),
        text: tab.label,
        attr: { type: "button", role: "tab", "aria-selected": index === 0 ? "true" : "false" },
      });
      btn.addEventListener("click", () => select(index));
      tabBar.appendChild(btn);
    });

    select(0);
  }

  /* -------------------------------------------------------------- general */

  private renderGeneral(host: HTMLElement): void {
    host.appendChild(h("p", { cls: "mtk-settings-note", text: t("settings.formatNote") }));

    new Setting(host)
      .setName(t("settings.flowDirection.name"))
      .setDesc(t("settings.flowDirection.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("TD", t("settings.direction.td"))
          .addOption("LR", t("settings.direction.lr"))
          .addOption("BT", t("settings.direction.bt"))
          .addOption("RL", t("settings.direction.rl"))
          .setValue(this.plugin.settings.flowDirection)
          .onChange(async (value) => {
            this.plugin.settings.flowDirection = value as FlowDirection;
            await this.plugin.saveSettings();
          })
      );

    new Setting(host)
      .setName(t("settings.mindmapLayout.name"))
      .setDesc(t("settings.mindmapLayout.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("right", t("settings.layout.right"))
          .addOption("left", t("settings.layout.left"))
          .addOption("both", t("settings.layout.both"))
          .setValue(this.plugin.settings.mindmapLayout)
          .onChange(async (value) => {
            this.plugin.settings.mindmapLayout = value as MindmapLayout;
            await this.plugin.saveSettings();
          })
      );

    new Setting(host)
      .setName(t("settings.persistPositions.name"))
      .setDesc(t("settings.persistPositions.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.persistPositions).onChange(async (value) => {
          this.plugin.settings.persistPositions = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(host)
      .setName(t("settings.openIn.name"))
      .setDesc(t("settings.openIn.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("modal", t("settings.openIn.modal"))
          .addOption("tab", t("settings.openIn.tab"))
          .setValue(this.plugin.settings.openIn)
          .onChange(async (value) => {
            this.plugin.settings.openIn = value === "tab" ? "tab" : "modal";
            await this.plugin.saveSettings();
          })
      );

    host.appendChild(this.buildReference());
  }

  private buildReference(): HTMLElement {
    const wrap = h("div", { cls: "mtk-kinds" });
    wrap.appendChild(h("h3", { cls: "mtk-kinds-title", text: t("settings.kinds.title") }));
    wrap.appendChild(h("p", { cls: "mtk-settings-note", text: t("settings.kinds.desc") }));

    const thead = h("thead");
    const headRow = h("tr");
    headRow.appendChild(h("th", { text: t("settings.kinds.col.diagram") }));
    headRow.appendChild(h("th", { text: t("settings.kinds.col.keyword") }));
    headRow.appendChild(h("th", { text: t("settings.kinds.col.scene") }));
    headRow.appendChild(h("th", { text: t("settings.kinds.col.editable") }));
    thead.appendChild(headRow);

    const tbody = h("tbody");
    for (const kind of DIAGRAM_KINDS) {
      const row = h("tr");
      row.appendChild(h("td", { cls: "mtk-kind-name", text: t(kind.nameKey) }));
      row.appendChild(h("td", { cls: "mtk-kind-keyword", text: kind.keyword }));
      row.appendChild(h("td", { cls: "mtk-kind-scene", text: t(kind.sceneKey) }));
      row.appendChild(
        h("td", {
          cls: kind.mode ? "mtk-kind-can-edit" : "mtk-kind-cannot-edit",
          text: kind.mode ? t("settings.kinds.yes") : t("settings.kinds.no"),
        })
      );
      tbody.appendChild(row);
    }

    const table = h("table", { cls: "mtk-kinds-table" });
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /* -------------------------------------------------------------- toolbar */

  /*
   * The tab is two things: one card that both explains and performs "add", and
   * the list itself.
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
    const commands = this.plugin.settings.toolbarCommands;

    host.appendChild(this.buildAddCard(host));

    const list = h("ul", { cls: "mtk-toolbar-cmd-list" });
    if (commands.length === 0) {
      list.appendChild(
        h("li", { cls: "mtk-toolbar-cmd-empty", text: t("settings.toolbar.empty") })
      );
    } else {
      for (const cmd of commands) list.appendChild(this.buildRow(host, commands, list, cmd, null));
    }
    host.appendChild(list);
  }

  /**
   * The card that carries both the instructions and the two "add" buttons.
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
    const card = h("div", { cls: "mtk-toolbar-add" });

    const copy = h("div", { cls: "mtk-toolbar-add-copy" });
    copy.appendChild(
      h("div", { cls: "mtk-toolbar-add-title", text: t("settings.toolbar.addTitle") })
    );
    copy.appendChild(h("p", { cls: "mtk-toolbar-add-desc", text: t("settings.toolbar.addDesc") }));
    card.appendChild(copy);

    const actions = h("div", { cls: "mtk-toolbar-add-actions" });

    const addBtn = h("button", {
      cls: "mtk-btn mtk-btn-primary",
      text: t("settings.toolbar.add"),
      attr: { type: "button" },
    });
    addBtn.addEventListener("click", () => this.openCommandModal(host, this.plugin.settings.toolbarCommands, null));
    actions.appendChild(addBtn);

    const submenuBtn = h("button", {
      cls: "mtk-btn",
      text: t("settings.toolbar.addSubmenu"),
      attr: { type: "button" },
    });
    submenuBtn.addEventListener("click", () => {
      this.openSubmenuModal(host, this.plugin.settings.toolbarCommands, null);
    });
    actions.appendChild(submenuBtn);

    card.appendChild(actions);
    return card;
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
    attachRowReorder(scope, moved, grip, commit);
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

  /* --------------------------------------------------------------- files */

  /**
   * Hiding and ordering share one page: both answer "what does the file
   * explorer show me", and neither half is long enough to carry a tab of its
   * own. Each half keeps a heading, so the page does not read as one long list.
   */
  private renderFiles(host: HTMLElement): void {
    host.appendChild(h("h3", { text: t("settings.files.hiding.heading") }));
    this.renderFileHiding(host);

    host.appendChild(h("h3", { text: t("settings.files.order.heading") }));

    // The order half gets a container of its own: the reset button rebuilds
    // that half in place, and rebuilding straight into `host` would take the
    // heading above it and the hiding half with it.
    const orderHost = h("div", {});
    host.appendChild(orderHost);
    this.renderFileOrder(orderHost);
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
  }

  /* -------------------------------------------------------------- order */

  private renderFileOrder(host: HTMLElement): void {
    // Cleared for the same reason as the toolbar panel: this is re-rendered in
    // place after the reset below, and appending would duplicate the page.
    // `host` is this half's own container, so clearing it leaves the heading
    // above and the hiding half before it untouched.
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
  }

  /* ----------------------------------------------------------- attachment */

  /* ----------------------------------------------------------- encryption */

  /**
   * Global password/session settings, then the two scheme-A features
   * (folder encryption, random password) render their own sections via
   * `buildSettingsUi`.
   */
  private renderEncryption(host: HTMLElement): void {
    this.plugin.randomPasswordFeature?.buildSettingsUi(host, () => this.plugin.saveSettings());

    host.appendChild(h("h3", { text: t("settings.encryption.passwords.heading") }));

    new Setting(host)
      .setName(t("settings.confirmPassword.name"))
      .setDesc(t("settings.confirmPassword.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmPassword).onChange(async (value) => {
          this.plugin.settings.confirmPassword = value;
          await this.plugin.saveSettings();
        })
      );

    const refreshTimeoutName = (setting: Setting, timeout: number): void => {
      const label =
        timeout === 0
          ? t("settings.rememberPasswordTimeout.untilClosed")
          : t("settings.rememberPasswordTimeout.forMinutes", { minutes: String(timeout) });
      setting.setName(t("settings.rememberPasswordTimeout.name", { timeout: label }));
    };

    new Setting(host)
      .setName(t("settings.rememberPassword.name"))
      .setDesc(t("settings.rememberPassword.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.rememberPassword).onChange(async (value) => {
          this.plugin.settings.rememberPassword = value;
          await this.plugin.saveSettings();
          SessionPasswordService.setActive(value);
          if (value) pwTimeoutSetting.settingEl.show();
          else pwTimeoutSetting.settingEl.hide();
        })
      );

    const pwTimeoutSetting = new Setting(host)
      .setDesc(t("settings.rememberPasswordTimeout.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 5)
          .setValue(this.plugin.settings.rememberPasswordTimeout)
          .onChange(async (value) => {
            this.plugin.settings.rememberPasswordTimeout = value;
            await this.plugin.saveSettings();
            SessionPasswordService.setAutoExpire(value === 0 ? null : value);
            refreshTimeoutName(pwTimeoutSetting, value);
          })
      );
    refreshTimeoutName(pwTimeoutSetting, this.plugin.settings.rememberPasswordTimeout);
    if (!this.plugin.settings.rememberPassword) {
      pwTimeoutSetting.settingEl.hide();
    }

    this.plugin.folderEncryptFeature?.buildSettingsUi(host, () => this.plugin.saveSettings());
  }

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

    host.appendChild(
      h("p", { cls: "mtk-settings-note", text: t("settings.attachment.tokens") })
    );

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

function attachRowReorder(
  list: HTMLElement,
  moved: HTMLElement,
  grip: HTMLElement,
  commit: () => void
): void {
  const rows = (): HTMLElement[] =>
    Array.from(list.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && typeof el.dataset.cmdId === "string"
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
