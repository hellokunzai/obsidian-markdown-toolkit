/**
 * The toolbar's data model, plus the list a fresh install starts with.
 *
 * Kept apart from the settings tab so the validation rules and the default
 * table can be exercised without a DOM: `main.ts` runs the sanitiser on every
 * load, and the smoke test drives it directly.
 */
import { t } from "../i18n";
import { TEXT_TOOLS, textToolCommandId } from "./text-tools";
import { ALIGN_TOOLS, textAlignCommandId } from "./text-align";
import { FONT_COLOR_COMMAND_ID, FONT_COLOR_ICON, FONT_COLOR_TOOL_ID } from "./font-color";
import {
  BACKGROUND_COLOR_COMMAND_ID,
  BACKGROUND_COLOR_ICON,
  BACKGROUND_COLOR_TOOL_ID,
} from "./background-color";
import { FOCUS_MODE_COMMAND_ID, FOCUS_MODE_ICON, FOCUS_MODE_TOOL_ID } from "./focus-mode";

/**
 * One entry in the editor toolbar.
 *
 * An entry is either a command button (`commandId` set), a submenu
 * (`commandId` empty, `children` holding what its menu shows), or a section
 * heading inside a submenu (`groupLabel`). Submenus nest exactly one level:
 * the reference plugin allows deeper trees, but a second level buys nothing
 * here while adding another layer for the settings list to render, reorder and
 * validate.
 */
export interface ToolbarCommand {
  /** Stable identity for drag-reorder and persistence. */
  id: string;
  /** The Obsidian command id executed when the button is pressed; empty for a submenu. */
  commandId: string;
  /** Visible label (falls back to the command's own name). */
  label: string;
  /** Icon name resolved through Obsidian's icon set. */
  icon: string;
  /** Menu items. Only ever set on a submenu, and never left empty. */
  children?: ToolbarCommand[];
  /**
   * Draw this entry as a heading rather than as something to press.
   *
   * Only meaningful inside a submenu: a heading on the toolbar itself would be
   * a button that does nothing, so the sanitiser drops it at the top level.
   */
  groupLabel?: boolean;
}

/** True when the entry opens a menu instead of running a command. */
export function isSubmenu(cmd: ToolbarCommand): boolean {
  return cmd.commandId === "" && cmd.groupLabel !== true;
}

/** True when the entry is a heading inside a submenu. */
export function isGroupLabel(cmd: ToolbarCommand): boolean {
  return cmd.groupLabel === true;
}

function command(id: string, commandId: string, icon: string, label: string = ""): ToolbarCommand {
  // Most entries carry no label: the registry already carries a name for each
  // of these ids — the core commands in the app's own language, and the brush
  // through this plugin's own t(). A handful of entries opt into a literal
  // label so the default bar reads the way the user asked for, in Chinese, on
  // first install — without pinning every entry to one locale.
  return { id, commandId, label, icon };
}

function submenu(id: string, icon: string, labelKey: string, children: ToolbarCommand[]): ToolbarCommand {
  // The key is a complete literal in this file, which is what makes the i18n
  // checker count it as a reference rather than report it as declared-but-unused.
  return { id, commandId: "", label: t(labelKey), icon, children };
}

function groupLabel(id: string, label: string): ToolbarCommand {
  return { id, commandId: "", label, icon: "", groupLabel: true };
}

/** Id of the bundled text-tools submenu, so the settings page can detect it. */
export const TEXT_TOOLS_MENU_ID = "menu-text-tools";

/**
 * The bundled 文本工具 submenu.
 *
 * Built from the catalog in `core/text-tools.ts` rather than typed out here, so
 * the menu, the registered commands and the executor table are three views of
 * one list instead of three lists that have to be kept in step by hand.
 *
 * The section headings are ordinary entries with `groupLabel` set. That is what
 * lets the settings page show, reorder and delete them like any other row — a
 * heading that only existed inside the menu builder would be invisible in the
 * one place where the user can actually edit the menu.
 */
export function textToolsSubmenu(): ToolbarCommand {
  const children: ToolbarCommand[] = [];
  for (const entry of TEXT_TOOLS) {
    // `in` rather than `entry.sectionKey`: the catalog is `as const`, so the
    // entries without a heading do not carry the property at all, and reading
    // it off the union is a type error.
    if ("sectionKey" in entry) {
      children.push(groupLabel(`text-tools-${entry.slug}-heading`, t(entry.sectionKey)));
    }
    children.push({
      id: `text-tools-${entry.slug}`,
      commandId: textToolCommandId(entry.slug),
      label: t(entry.nameKey),
      icon: entry.icon,
    });
  }
  return {
    id: TEXT_TOOLS_MENU_ID,
    commandId: "",
    label: t("settings.toolbar.group.text"),
    icon: "box",
    children,
  };
}

/** Id of the bundled text-alignment submenu, so the settings page can detect it. */
export const TEXT_ALIGN_MENU_ID = "menu-text-align";

/**
 * The bundled 文本对齐 submenu.
 *
 * Four entries and no headings: each one both applies its alignment and takes
 * it off again, so there is no state to show and nothing to group them under.
 * Built from the catalog for the same reason the text tools are — the menu and
 * the four commands stay one list rather than three that have to be kept in
 * step by hand.
 *
 * The button is drawn with `align-center` rather than one of the four items'
 * own icons: it is the glyph that reads as "alignment" on its own, and the
 * reference plugin draws its submenu button the same way — a 4-line mark,
 * centred.
 */
export function textAlignSubmenu(): ToolbarCommand {
  return {
    id: TEXT_ALIGN_MENU_ID,
    commandId: "",
    label: t("settings.toolbar.group.align"),
    icon: "align-center",
    children: ALIGN_TOOLS.map((entry) => ({
      id: `text-align-${entry.slug}`,
      commandId: textAlignCommandId(entry.slug),
      label: t(entry.nameKey),
      icon: entry.icon,
    })),
  };
}

/** Id of the bundled 图表 submenu, so the settings page can detect it. */
export const DIAGRAM_MENU_ID = "menu-diagram";

/**
 * The bundled 图表 submenu.
 *
 * Unlike the five submenus ported from the reference plugin, this one has no
 * original to copy: `obsidian-editing-toolbar` ships no diagram entries, so all
 * three items point at commands this plugin registers itself — and therefore
 * carry the plugin's command-id prefix.
 *
 * Three entries and no headings. The flow and mind-map inserts are the two
 * kinds a writer reaches for by name, and the picker behind the third covers
 * every other kind, so a heading would only add a line to a menu this short.
 *
 * The button is drawn with `bar-chart-2` rather than one of the items' own
 * glyphs: it is what reads as "chart" on its own, and it keeps the three items
 * (branch, network, pie) individually legible.
 */
export function diagramSubmenu(): ToolbarCommand {
  return submenu(DIAGRAM_MENU_ID, "bar-chart-2", "settings.toolbar.group.diagram", [
    command("diagram-flow", "markdown-toolkit:insert-flow", "git-branch"),
    command("diagram-mindmap", "markdown-toolkit:insert-mindmap", "network"),
    command("diagram-any", "markdown-toolkit:insert-any", "pie-chart"),
  ]);
}

/**
 * The bundled 字体颜色 entry.
 *
 * A plain command rather than a submenu: pressing it does not pick a colour,
 * it opens the swatch panel. The entry is still built from the command id the
 * command palette uses, so the two cannot drift — and `colorPanelFor` below
 * is the single place that says the toolbar has to treat this one differently.
 */
export function fontColorEntry(): ToolbarCommand {
  return command(FONT_COLOR_TOOL_ID, FONT_COLOR_COMMAND_ID, FONT_COLOR_ICON, "字体颜色");
}

/**
 * The bundled 背景颜色 entry.
 *
 * The same shape as the font-colour one, and for the same reason: the panel is
 * a five-column grid of circles, which no native `Menu` can hold.
 */
export function backgroundColorEntry(): ToolbarCommand {
  return command(BACKGROUND_COLOR_TOOL_ID, BACKGROUND_COLOR_COMMAND_ID, BACKGROUND_COLOR_ICON, "背景颜色");
}

/**
 * The bundled 全屏专注模式 entry.
 *
 * A plain command button, and the only one of the three this plugin adds that
 * needs nothing special: there is no panel to anchor and no menu to open, so a
 * press is just the command running. It is called out here anyway because
 * `defaultToolbarCommands` is where the bundled entries are collected, and
 * because the absence of a panel is a decision rather than an oversight.
 */
export function focusModeEntry(): ToolbarCommand {
  return command(FOCUS_MODE_TOOL_ID, FOCUS_MODE_COMMAND_ID, FOCUS_MODE_ICON, "全屏专注");
}

/** Which panel a toolbar press opens, when it opens one at all. */
export type ColorPanel = "font" | "background";

/**
 * The panel this entry opens, or `null` when the press runs the command.
 *
 * The toolbar asks this rather than comparing ids itself, so the rule lives
 * beside the entries it is about — and so the smoke test can assert on the same
 * predicate the view uses instead of restating it. The name of the feature is
 * the answer rather than a bare boolean because the two entries open different
 * palettes: they share the panel, not the colours.
 */
export function colorPanelFor(cmd: ToolbarCommand): ColorPanel | null {
  if (cmd.commandId === FONT_COLOR_COMMAND_ID) return "font";
  if (cmd.commandId === BACKGROUND_COLOR_COMMAND_ID) return "background";
  return null;
}

/**
 * The toolbar a fresh install starts with.
 *
 * Ported from `obsidian-editing-toolbar`'s `menuCommands` and then reordered and
 * relabelled at the user's request. The top-level shape is the same — undo/redo
 * first, the format painter and clear-format right after, then headings, then
 * the inline formats, then the bundled submenus, then the colour/align/focus
 * entries the plugin registers itself — but the exact sequence and a few
 * literal labels differ from the original default:
 *
 *   undo, redo, format-brush, clear-format,
 *   heading-2, heading-3, menu-heading (header-n: 1/4/5/6),
 *   bold, italic, strikethrough, underline, highlight,
 *   text-tools, attach-file, insert-table,
 *   menu-quote, menu-insert, menu-diagram, menu-list,
 *   cycle-checklist, text-align, font-color, background-color, focus-mode
 *
 * The 编辑 (cut/copy/paste/line-move) submenu from the reference plugin is
 * dropped: the same jobs live in the native right-click menu and on the
 * keyboard, so a second copy on the bar was clutter.
 */
export function defaultToolbarCommands(): ToolbarCommand[] {
  return [
    command("undo", "editor:undo", "undo-2", "撤销编辑"),
    command("redo", "editor:redo", "redo-2", "重做编辑"),

    // The painter is this plugin's own command, so the id carries the prefix.
    // It sits right after undo/redo, ahead of the erasers and headings, at the
    // user's request.
    command("format-brush", "markdown-toolkit:toggle-format-brush", "paintbrush", "格式刷"),
    command("clear-format", "editor:clear-formatting", "eraser", "清除文本格式"),

    command("heading-2", "editor:set-heading-2", "heading-2", "标题 2"),
    command("heading-3", "editor:set-heading-3", "heading-3", "标题 3"),

    // Heading 1/4/5/6 only: 2 and 3 are already top-level buttons above, so
    // repeating them here would be two ways to do the same thing. The button
    // glyph is `lucide-heading` (a registered Obsidian icon id) per the
    // requested layout.
    submenu("menu-heading", "lucide-heading", "settings.toolbar.group.heading", [
      command("menu-heading-1", "editor:set-heading-1", "heading-1"),
      command("menu-heading-4", "editor:set-heading-4", "heading-4"),
      command("menu-heading-5", "editor:set-heading-5", "heading-5"),
      command("menu-heading-6", "editor:set-heading-6", "heading-6"),
    ]),

    command("bold", "editor:toggle-bold", "bold"),
    command("italic", "editor:toggle-italics", "italic"),
    command("strikethrough", "editor:toggle-strikethrough", "strikethrough"),
    // The second non-core entry, for the same reason as the brush: no core
    // command writes an underline, so this one is the plugin's own.
    command("underline", "markdown-toolkit:toggle-underline", "underline", "下划线"),
    command("highlight", "editor:toggle-highlight", "highlighter"),

    // The whole text-tools submenu, every item of which is this plugin's own
    // command. It sits where the user put it: right after the inline formats.
    textToolsSubmenu(),

    command("attach-file", "editor:attach-file", "paperclip"),
    command("insert-table", "editor:insert-table", "table"),

    submenu("menu-quote", "text-quote", "settings.toolbar.group.quote", [
      command("menu-quote-block", "editor:toggle-blockquote", "text-quote"),
      command("menu-quote-callout", "editor:insert-callout", "message-square-quote"),
    ]),

    submenu("menu-insert", "plus-square", "settings.toolbar.group.insert", [
      command("menu-insert-code", "editor:toggle-code", "code"),
      command("menu-insert-codeblock", "editor:insert-codeblock", "square-code"),
      command("menu-insert-wikilink", "editor:insert-wikilink", "link"),
      command("menu-insert-embed", "editor:insert-embed", "file-symlink"),
      command("menu-insert-link", "editor:insert-link", "link-2"),
      command("menu-insert-rule", "editor:insert-horizontal-rule", "minus"),
      command("menu-insert-mathblock", "editor:insert-mathblock", "sigma"),
      command("menu-insert-inline-math", "editor:toggle-inline-math", "function-square"),
    ]),

    // This plugin's own diagram submenu, placed beside Insert so the two
    // "insert" families sit together. The reference has no diagram entries, so
    // unlike the menus above there is nothing to port.
    diagramSubmenu(),

    submenu("menu-list", "list", "settings.toolbar.group.list", [
      command("menu-list-checklist", "editor:toggle-checklist-status", "square-check"),
      command("menu-list-numbered", "editor:toggle-numbered-list", "list-ordered"),
      command("menu-list-bullet", "editor:toggle-bullet-list", "list"),
      command("menu-list-indent", "editor:indent-list", "indent-increase"),
      command("menu-list-outdent", "editor:unindent-list", "indent-decrease"),
    ]),

    command("cycle-checklist", "editor:cycle-list-checklist", "list-checks"),

    // text-align, then the plugin's own colour panels and focus mode, close
    // the bar — the entries a fresh install looks for at the end.
    textAlignSubmenu(),
    fontColorEntry(),
    backgroundColorEntry(),
    focusModeEntry(),
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toCommand(value: unknown): ToolbarCommand | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.commandId !== "string") return null;
  const cmd: ToolbarCommand = {
    id: value.id,
    commandId: value.commandId,
    label: typeof value.label === "string" ? value.label : "",
    icon: typeof value.icon === "string" ? value.icon : "",
  };
  if (value.groupLabel === true) cmd.groupLabel = true;
  return cmd;
}

function readLevel(raw: unknown, depth: number, seen: Set<string>): ToolbarCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolbarCommand[] = [];

  for (const entry of raw) {
    const base = toCommand(entry);
    // A duplicated id would make drag-reorder ambiguous and let a saved order
    // drop one of the two, so the first one wins and the copy is discarded.
    if (!base || seen.has(base.id)) continue;
    seen.add(base.id);

    const children = readLevel(isRecord(entry) ? entry.children : undefined, depth + 1, seen);

    if (isGroupLabel(base)) {
      // A heading only means something inside a menu; on the toolbar it would
      // be a button that does nothing at all.
      if (depth === 0) continue;
      out.push(base);
      continue;
    }

    if (depth > 0 || children.length === 0) {
      // Nested submenus are flattened rather than dropped: the only way to get
      // one is a hand-edited data.json, and hoisting its items keeps them
      // reachable instead of silently losing them.
      out.push(base, ...children);
      continue;
    }
    if (isSubmenu(base)) {
      out.push({ ...base, children });
      continue;
    }
    // A command that somehow also carries a menu: stay runnable, and hoist the
    // menu items so they survive.
    out.push(base, ...children);
  }
  return out;
}

/**
 * Validates whatever came out of `data.json`.
 *
 * Every field is checked rather than trusted, because a hand-edited file must
 * never be able to put the settings list into a state its own controls cannot
 * express — a row with no id, a submenu three levels deep, or two entries
 * sharing an id. Invalid entries are dropped, over-deep nesting is flattened to
 * one level, and the result is always freshly built objects, so nothing here
 * shares structure with the module-level defaults.
 */
export function sanitizeToolbarCommands(raw: unknown): ToolbarCommand[] {
  return readLevel(raw, 0, new Set<string>());
}

/**
 * Every command-id prefix an earlier release stored in `data.json`, newest
 * first.
 *
 * Only this plugin's own buttons carry a prefix — every other entry in the
 * default toolbar is a core command — so rewriting the prefix is the whole
 * migration. It cannot be skipped either: `sanitizeToolbarCommands` validates
 * shape rather than existence, so a stale id survives as a button that renders,
 * accepts a click, and does nothing at all.
 *
 * Frozen for the same reason as the annotation tokens in `model.ts`: each entry
 * was shipped into somebody's settings at some point and cannot be renamed
 * retroactively.
 */
export const LEGACY_COMMAND_PREFIXES: readonly string[] = [
  "markdown-editor-plus:", // 0.17.0
  "mindforge:", // up to 0.16.0
];

/**
 * Rewrites saved toolbar command ids onto the current prefix.
 *
 * The current prefix is a parameter rather than a constant here, so the caller
 * can derive it from the manifest id. A second copy of it in this file could
 * drift from the id the app actually registers commands under, and the failure
 * would look exactly like the one this function exists to fix.
 */
/** Longest match wins, so a prefix that is a prefix of another cannot shadow it. */
function rewriteCommandPrefix(commandId: string, currentPrefix: string): string {
  let best: string | null = null;
  for (const legacy of LEGACY_COMMAND_PREFIXES) {
    if (commandId.startsWith(legacy) && (best === null || legacy.length > best.length)) best = legacy;
  }
  return best === null ? commandId : currentPrefix + commandId.slice(best.length);
}

export function migrateToolbarCommandIds(
  commands: ToolbarCommand[],
  currentPrefix: string
): ToolbarCommand[] {
  return commands.map((cmd) => {
    const migrated: ToolbarCommand = {
      ...cmd,
      commandId: rewriteCommandPrefix(cmd.commandId, currentPrefix),
    };
    if (cmd.children) migrated.children = migrateToolbarCommandIds(cmd.children, currentPrefix);
    return migrated;
  });
}
