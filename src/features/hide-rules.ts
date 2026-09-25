import { setIcon, type App, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type MarkdownEditorPlusPlugin from "../main";

/**
 * Hidden entry rules for the file explorer.
 *
 * Each line of the `hiddenRules` setting names entries to hide, using the rule
 * syntax of the `obsidian-hide-folders` plugin: an exact name, a
 * `startsWith::PREFIX`, or an `endsWith::SUFFIX`. Rules are matched against the
 * last path segment, so a single line covers both a folder and a file of that
 * name — what the setting describes is what you see in the explorer, not a kind
 * of item. A file rule therefore has to spell out its extension.
 *
 * Hiding is a CSS class rather than an inline style: the explorer's markup is
 * left intact, and removing the class restores the tree exactly.
 *
 * A MutationObserver watches each explorer's content element and the rules are
 * re-applied on any structural change, so added, renamed and removed entries are
 * handled without polling.
 */

const PREFIX_TOKEN = "startswith::";
const SUFFIX_TOKEN = "endswith::";
const HIDDEN_CLASS = "mtk-explorer-hidden";

type RuleKind = "exact" | "prefix" | "suffix";

interface RawRule {
  kind: RuleKind;
  value: string;
}

/**
 * The rules, ready to match against a name. The patterns are folded once here
 * rather than on every comparison, because `apply()` walks the whole tree.
 */
export interface HiddenMatchers {
  exact: Set<string>;
  prefixes: string[];
  suffixes: string[];
  ignoreCase: boolean;
}

/**
 * Two config methods live on `Vault` without appearing in the public typings.
 * Obsidian's excluded-files ("ignore") list has no documented writer, and the
 * only alternative is asking the user to retype every rule by hand in Obsidian's
 * own settings — where this plugin could not keep them in step.
 */
interface VaultConfigAccess {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

/**
 * Splits the setting into rules.
 *
 * The token is recognised case-insensitively, so `startsWith::` and
 * `startswith::` behave the same, and it is stripped from the value: a rule is
 * the name to look for, not the syntax wrapped around it. Blank lines — and a
 * token with nothing after it — are dropped rather than becoming a rule that
 * would match every entry.
 */
function parseRules(raw: string): RawRule[] {
  const rules: RawRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith(PREFIX_TOKEN)) {
      const value = trimmed.slice(PREFIX_TOKEN.length).trim();
      if (value) rules.push({ kind: "prefix", value });
    } else if (lower.startsWith(SUFFIX_TOKEN)) {
      const value = trimmed.slice(SUFFIX_TOKEN.length).trim();
      if (value) rules.push({ kind: "suffix", value });
    } else {
      rules.push({ kind: "exact", value: trimmed });
    }
  }
  return rules;
}

/**
 * Escapes the characters that would otherwise be read as regex syntax. `/` is
 * deliberately left alone: the entry is compiled from its own body (Obsidian
 * strips the surrounding slashes and passes the rest to `new RegExp`), so a
 * literal slash needs no escaping — and the entry is shown to the user verbatim
 * in Obsidian's own settings, where a stray backslash only confuses.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class HideRules {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;
  /** Explorer content element -> the observer watching it, so it can be dropped. */
  private readonly observers = new Map<HTMLElement, MutationObserver>();
  private ribbonIcon: HTMLElement | null = null;
  private statusBarItem: HTMLElement | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.ribbonIcon = this.plugin.addRibbonIcon(this.ribbonIconName(), this.ribbonLabel(), () => {
      void this.toggle();
    });

    // Registered so Obsidian drops the listener on plugin unload, avoiding
    // callbacks against a torn-down workspace.
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.attach()));
    // A renamed folder takes its children's paths with it. The explorer repaints
    // just after the event, so reading the DOM immediately would still see the
    // old paths.
    this.plugin.registerEvent(
      this.app.vault.on("rename", () => window.setTimeout(() => this.apply(), 10))
    );

    this.attach();
    this.syncIgnoreList();
  }

  /** Stops watching the explorers. Called from the plugin's `onunload`. */
  unload(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  /** Flips the master switch; the rules themselves are left untouched. */
  async toggle(): Promise<void> {
    this.plugin.settings.hiddenEnabled = !this.plugin.settings.hiddenEnabled;
    await this.plugin.refreshHideRules();
  }

  /** Re-reads the settings and re-applies everything they drive. */
  refresh(): void {
    this.updateRibbon();
    this.apply();
    this.syncIgnoreList();
  }

  /* ------------------------------------------------------------- observers */

  /** (Re)attach observers to every file-explorer leaf that exists now. */
  private attach(): void {
    // Observers outlive the elements they watch: a rebuilt explorer leaves the
    // old one detached but still observed. Dropping those keeps the set equal to
    // the number of live explorers instead of growing with every layout change.
    for (const [element, observer] of this.observers) {
      if (element.isConnected) continue;
      observer.disconnect();
      this.observers.delete(element);
    }

    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const contentEl = this.contentEl(leaf);
      if (!contentEl || this.observers.has(contentEl)) continue;
      const observer = new MutationObserver(() => this.apply());
      observer.observe(contentEl, { childList: true, subtree: true });
      this.observers.set(contentEl, observer);
    }

    this.apply();
  }

  /**
   * The explorer view's content element. Read as a structural property rather
   * than through a cast of the whole view, because no explorer view type is
   * exported to cast to.
   */
  private contentEl(leaf: WorkspaceLeaf): HTMLElement | null {
    const view = leaf.view as unknown as { contentEl?: HTMLElement };
    return view.contentEl ?? null;
  }

  /* -------------------------------------------------------------- matching */

  private matchers(): HiddenMatchers {
    const ignoreCase = this.plugin.settings.hiddenIgnoreCase;
    const fold = (value: string): string => (ignoreCase ? value.toLowerCase() : value);
    const matchers: HiddenMatchers = {
      exact: new Set<string>(),
      prefixes: [],
      suffixes: [],
      ignoreCase,
    };

    for (const rule of parseRules(this.plugin.settings.hiddenRules ?? "")) {
      if (rule.kind === "prefix") matchers.prefixes.push(fold(rule.value));
      else if (rule.kind === "suffix") matchers.suffixes.push(fold(rule.value));
      else matchers.exact.add(fold(rule.value));
    }
    return matchers;
  }

  private matches(name: string, matchers: HiddenMatchers): boolean {
    const key = matchers.ignoreCase ? name.toLowerCase() : name;
    if (matchers.exact.has(key)) return true;
    if (matchers.prefixes.some((prefix) => key.startsWith(prefix))) return true;
    return matchers.suffixes.some((suffix) => key.endsWith(suffix));
  }

  apply(): void {
    const matchers = this.matchers();
    const enabled = this.plugin.settings.hiddenEnabled;
    let count = 0;

    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const contentEl = this.contentEl(leaf);
      if (!contentEl) continue;
      const items = contentEl.querySelectorAll<HTMLElement>(
        ".nav-folder-children > .nav-file, .nav-folder-children > .nav-folder"
      );
      for (const item of items) {
        const path = item.getAttribute("data-path") ?? "";
        const name = path.split("/").pop() ?? "";
        const hidden = enabled && this.matches(name, matchers);
        if (hidden) count++;
        item.classList.toggle(HIDDEN_CLASS, hidden);
      }
    }

    this.updateStatusBar(count);
  }

  /* ----------------------------------------------------------- status bar */

  private updateStatusBar(count: number): void {
    if (this.plugin.settings.hiddenStatusBar) {
      this.statusBarItem?.remove();
      this.statusBarItem = null;
      return;
    }
    if (!this.statusBarItem) this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.textContent = this.plugin.settings.hiddenEnabled
      ? t("hideRules.statusBar.hidden", { count: String(count) })
      : "";
  }

  /* --------------------------------------------------------------- ribbon */

  /**
   * The icon names the action, matching the plugin this rule syntax comes from:
   * while entries are hidden, the eye invites you to reveal them.
   */
  private ribbonIconName(): string {
    return this.plugin.settings.hiddenEnabled ? "eye" : "eye-off";
  }

  private ribbonLabel(): string {
    return this.plugin.settings.hiddenEnabled
      ? t("hideRules.ribbon.show")
      : t("hideRules.ribbon.hide");
  }

  private updateRibbon(): void {
    if (!this.ribbonIcon) return;
    setIcon(this.ribbonIcon, this.ribbonIconName());
    // `aria-label` rather than `title`: the app's tooltip layer reads attributes
    // on `[aria-label]` only, and a `title` would fall through to the plain OS
    // tooltip next to buttons that show the themed one.
    this.ribbonIcon.setAttribute("aria-label", this.ribbonLabel());
  }

  /* ---------------------------------------------------- excluded-files list */

  private configVault(): VaultConfigAccess | null {
    const vault = this.app.vault as unknown as Partial<VaultConfigAccess>;
    return typeof vault.getConfig === "function" && typeof vault.setConfig === "function"
      ? (vault as VaultConfigAccess)
      : null;
  }

  /**
   * One regular expression per rule, in the shape the excluded-files list
   * expects: the same three forms the rules themselves come in.
   *
   * Note what is *not* done here. The setting's own ignore-case toggle cannot be
   * carried into these entries, because Obsidian compiles any `/…/` entry with
   * the `i` flag unconditionally — case-insensitivity is not something this side
   * gets to choose, so writing it out as character classes would only make the
   * entry unreadable in the user's own settings for no gain.
   */
  private ignoreListEntries(): string[] {
    const out: string[] = [];
    for (const rule of parseRules(this.plugin.settings.hiddenRules ?? "")) {
      const name = escapeRegExp(rule.value);
      if (rule.kind === "prefix") out.push(`/(^${name})|(/${name})/`);
      else if (rule.kind === "suffix") out.push(`/(${name}$)|(${name}/)/`);
      else out.push(`/${name}/`);
    }
    return out;
  }

  /**
   * Keeps Obsidian's own excluded-files list in step with the rules.
   *
   * The list is written through an untyped API, so whatever it returns is
   * treated as unknown and only strings survive a round trip. The exact strings
   * this plugin wrote last time are stored in the settings and removed first —
   * that, rather than re-deriving them, is what stops a rule the user has since
   * deleted from lingering in the list forever.
   */
  syncIgnoreList(): void {
    const previous = this.plugin.settings.hiddenExcludeEntries;
    const wanted =
      this.plugin.settings.hiddenExcludeList && this.plugin.settings.hiddenEnabled
        ? this.ignoreListEntries()
        : [];
    this.plugin.settings.hiddenExcludeEntries = wanted;

    const vault = this.configVault();
    if (!vault) {
      if (wanted.length > 0) {
        console.error(
          "[markdown-toolkit] the vault config API is unavailable, so the excluded-files list was left alone."
        );
      }
      return;
    }

    const raw = vault.getConfig("userIgnoreFilters");
    const current = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];

    const next = current.filter((entry) => !previous.includes(entry));
    for (const entry of wanted) if (!next.includes(entry)) next.push(entry);
    // Called on every settings edit and on load, so an unchanged list is left
    // unwritten: `setConfig` is not free, and it republishes to every listener.
    if (next.length === current.length && next.every((entry, i) => entry === current[i])) return;

    vault.setConfig("userIgnoreFilters", next);
  }
}
