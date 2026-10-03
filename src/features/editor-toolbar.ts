import { MarkdownView, setIcon, type App } from "obsidian";
import type MarkdownEditorPlusPlugin from "../main";
import { applyToolbarBackground, TOOLBAR_BACKGROUND_DEFAULT } from "../core/toolbar-background";
import { appendToolbarButtons, closeToolbarColorPicker } from "./toolbar-buttons";
import { t } from "../i18n";

/** TEMPORARY: one DOM dump per plugin load, for the mobile placement bug. */
let dumpedForSession = false;

/**
 * Editor toolbar.
 *
 * Renders the commands configured in settings as a bar pinned to the top of the
 * active Markdown editor. It is re-pinned whenever the active leaf changes, and
 * removed when the editor is not in source mode. Command execution is delegated
 * to Obsidian's own command registry, so anything in the palette works here —
 * including the plugin's own insert/edit commands.
 *
 * An entry with children opens a menu instead of running anything; the menu is
 * Obsidian's own, so it picks up the theme, the placement heuristics and the
 * keyboard handling for free. The two colour entries are the exception: their
 * commands exist, but the toolbar opens a swatch panel for them, anchored to
 * the button, because neither grid fits in a menu.
 */
export class EditorToolbar {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;
  private observer: MutationObserver | null = null;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sync()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.sync()));
    // The initial onload call often runs before the workspace leaves are ready,
    // so wait for layout ready before the first real pin attempt.
    this.app.workspace.onLayoutReady(() => this.sync());
  }

  /**
   * Stops watching and takes the bar down.
   *
   * The observer is not registered through `registerEvent`, so nothing else
   * clears it: left alone it outlives `onunload` and re-pins the toolbar the
   * next time the view re-renders — a plugin that is meant to be off.
   */
  unload(): void {
    this.remove();
  }

  /** Re-applies the toolbar to the current active Markdown editor. */
  sync(): void {
    this.disconnectObserver();

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") {
      this.remove();
      return;
    }

    const contentEl = view.contentEl;
    /* `placeBar` anchors the bar to the editor surface, which can live one
     * layer above or below the content element depending on the build. A
     * look-up scoped to the content then misses an existing bar and builds a
     * second one, so fall back to the document-wide one before building. */
    let bar = (contentEl.querySelector(".mtk-editor-toolbar") ??
      document.querySelector(".mtk-editor-toolbar")) as HTMLElement | null;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "mtk-editor-toolbar";
    }
    const branch = this.placeBar(contentEl, bar);
    this.renderBar(bar);
    this.dumpDomOnce(contentEl, bar, branch);

    // Re-pin if Obsidian re-renders the view (mode switch, inline title toggle,
    // or workspace replace). childList is enough: we only care about structural
    // changes that could evict the toolbar. Watch whichever layer the bar ended
    // up in — that is the layer a re-pin has to reach again.
    this.observer = new MutationObserver(() => this.sync());
    this.observer.observe(bar.parentElement ?? contentEl, { childList: true });
  }

  /**
   * TEMPORARY DIAGNOSTIC — remove once the mobile placement bug is pinned.
   *
   * Two fixes have shipped against an imagined mobile DOM and both missed, so
   * the guessing stops here: on a phone, the first sync of a session writes the
   * real structure to `mtk-dom-debug.txt` in the vault root. The marker string
   * also proves which build produced the file, so an outdated copy can never
   * masquerade as "the fix did nothing".
   */
  private dumpDomOnce(contentEl: HTMLElement, bar: HTMLElement, branch: string): void {
    if (dumpedForSession) return;
    if (!document.body.classList.contains("is-mobile")) return;
    dumpedForSession = true;
    const describe = (el: Element | null): string => {
      if (!el) return "(none)";
      return `${el.tagName.toLowerCase()} .${(el.getAttribute("class") ?? "").replace(/\s+/g, " .")}`;
    };
    const rect = (el: Element | null): string => {
      if (!el) return "(none)";
      const r = el.getBoundingClientRect();
      return `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} height=${Math.round(r.height)} left=${Math.round(r.left)} width=${Math.round(r.width)}`;
    };
    const css = (el: Element | null, props: string[]): string => {
      if (!el) return "(none)";
      const s = getComputedStyle(el);
      return props.map((p) => `${p}: ${s.getPropertyValue(p)}`).join("; ");
    };
    const leafContent = contentEl.closest(".workspace-leaf-content");
    const header = document.querySelector(".view-header");
    const sourceView = contentEl.querySelector(".markdown-source-view");
    const rootStyle = getComputedStyle(document.body);
    const POS = ["position", "top", "left", "right", "bottom", "z-index", "transform", "margin-top", "order"];
    const BOX = ["display", "flex-direction", "padding-top", "overflow", "height"];
    const lines: string[] = [
      "MARKER: mtk-dom-debug v6 (safe-area+header-offset build, 2026-10-03)",
      "time: " + new Date().toISOString(),
      "is-mobile: " + document.body.classList.contains("is-mobile"),
      "is-hidden-nav: " + document.body.classList.contains("is-hidden-nav"),
      "body classes: " + document.body.className,
      "--safe-area-inset-top: " + rootStyle.getPropertyValue("--safe-area-inset-top"),
      "--view-header-height: " + rootStyle.getPropertyValue("--view-header-height"),
      "placeBar branch taken: " + branch,
      "bar computed margin-top: " + getComputedStyle(bar).marginTop,
      "window: innerWidth=" + window.innerWidth + " innerHeight=" + window.innerHeight + " scrollY=" + Math.round(window.scrollY),
      "",
      "== 纵向位置（谁在上谁在下，一目了然） ==",
      ".view-header        rect: " + rect(header),
      ".mtk-editor-toolbar rect: " + rect(bar),
      ".markdown-source    rect: " + rect(sourceView),
      ".view-content       rect: " + rect(contentEl),
      ".workspace-leaf-content rect: " + rect(leafContent),
      "",
      "== 定位相关 computed style ==",
      "[bar] " + css(bar, POS),
      "[bar] " + css(bar, BOX),
      "[bar.offsetParent] " + describe(bar.offsetParent as Element | null),
      "[header] " + css(header, POS),
      "[header] " + css(header, BOX),
      "[contentEl] " + css(contentEl, POS),
      "[contentEl] " + css(contentEl, BOX),
      "[leafContent] " + css(leafContent, POS),
      "[leafContent] " + css(leafContent, BOX),
      "[sourceView] " + css(sourceView, ["position", "top", "margin-top", "padding-top", "transform"]),
      "",
      "== DOM 结构 ==",
      "view.contentEl: " + describe(contentEl),
      "contentEl children:",
      ...[...contentEl.children].slice(0, 8).map((c) => "  - " + describe(c)),
      "bar parent: " + describe(bar.parentElement),
      "bar prev sibling: " + describe(bar.previousElementSibling),
      "bar next sibling: " + describe(bar.nextElementSibling),
      "header parent: " + describe(header?.parentElement ?? null),
      "header prev sibling: " + describe(header?.previousElementSibling ?? null),
      "header next sibling: " + describe(header?.nextElementSibling ?? null),
      "leafContent children:",
      ...(leafContent ? [...leafContent.children].slice(0, 8).map((c) => "  - " + describe(c)) : []),
      "",
      "== body 直接子元素（找浮动在最顶部的元素） ==",
      ...[...document.body.children].slice(0, 12).map((c) => "  - " + describe(c)),
    ];
    this.app.vault.adapter
      .write("mtk-dom-debug.txt", lines.join("\n"))
      .catch(() => undefined);
  }

  /**
   * Puts the bar *inside* the editor surface, at its very top.
   *
   * The mobile layout floats `.view-header` over the content and gives
   * `.markdown-source-view` a `padding-top` to push its contents clear of it.
   * A bar placed *before* the source view sits above that padding — and
   * therefore above the header, jammed against the status bar, while every
   * re-pin by DOM order alone keeps landing in the same wrong spot. Placed
   * *inside* the source view instead, the bar rides the same padding as the
   * text and ends up exactly where the reference layout has it: header, then
   * tools, then text. This is the same anchor the editing-toolbar plugin uses
   * for its pinned bar (`.view-content > div:first-child`, `afterbegin`).
   */
  private placeBar(contentEl: HTMLElement, bar: HTMLElement): string {
    const editor = (contentEl.querySelector(".markdown-source-view") ??
      contentEl.querySelector(".cm-editor")) as HTMLElement | null;
    if (!editor) {
      this.pinTo(contentEl, bar, contentEl.firstChild);
      return "fallback-firstChild (no editor found)";
    }
    if (bar.parentElement === editor && editor.firstElementChild === bar) {
      // Already at the top of the editor. Repositioning an existing node is
      // itself a mutation, and the observer would report it and ask for
      // another placement — a loop built out of nothing.
      return "already-placed-inside-editor";
    }
    editor.insertBefore(bar, editor.firstChild);
    return "moved-inside-editor";
  }

  /** Drops the bar in front of `ref`, unless that is where it already sits. */
  private pinTo(host: HTMLElement, bar: HTMLElement, ref: ChildNode | null): void {
    if (bar.parentElement === host && bar.nextSibling === ref) return;
    host.insertBefore(bar, ref);
  }

  private renderBar(bar: HTMLElement): void {
    // Avoid Obsidian's prototype extension for portability.
    bar.replaceChildren();
    /* Painted before the empty check below, so a bar that is hidden right now
       still carries the colour the moment a command is added to it. Read
       defensively: `data.json` may predate the field, and the value would then
       be `undefined` — which would be written into the property verbatim. */
    const background = this.plugin.settings.editorToolbarBackground;
    applyToolbarBackground(
      bar,
      typeof background === "string" ? background : TOOLBAR_BACKGROUND_DEFAULT
    );
    const commands = this.plugin.settings.toolbarCommands;
    if (commands.length === 0) {
      bar.classList.add("is-empty");
      return;
    }
    bar.classList.remove("is-empty");

    // The buttons are built by the shared helper the selection toolbar also
    // uses, so the pinned bar and the floating bar can never disagree about
    // what a command looks like or how its press behaves.
    const strip = document.createElement("div");
    strip.className = "mtk-editor-toolbar-scroll";
    strip.id = "mtk-editor-toolbar-strip";
    appendToolbarButtons(strip, this.plugin);
    bar.appendChild(strip);

    if (document.body.classList.contains("is-mobile")) {
      this.addPagingArrows(bar, strip);
    }
  }

  /**
   * Puts a paging arrow at each end of the command strip.
   *
   * A phone cannot fit every command on one line, and wrapping them would pile
   * a screenful of the plugin's own buttons on top of the line being edited.
   * So the strip keeps one line and scrolls; these two arrows are the only
   * affordance telling there is more of it either side.
   *
   * They exist only while scrolling is actually possible — a short command list
   * gets none, so the bar never shows an arrow that does nothing — and the one
   * pointing the way you already are gets disabled at each end.
   */
  private addPagingArrows(bar: HTMLElement, strip: HTMLElement): void {
    const prev = document.createElement("button");
    const next = document.createElement("button");
    const arrows: readonly [HTMLButtonElement, string, string][] = [
      [prev, "chevron-left", "editor.toolbar.navPrev"],
      [next, "chevron-right", "editor.toolbar.navNext"],
    ];
    for (const [btn, icon, key] of arrows) {
      btn.type = "button";
      btn.className = "mtk-toolbar-btn mtk-nav";
      btn.setAttribute("aria-label", t(key));
      // Same role the bar's own buttons have, so the two read the same to a
      // screen reader rather than as a second kind of control.
      btn.setAttribute("aria-controls", strip.id);
      setIcon(btn, icon);
    }
    bar.insertBefore(prev, strip);
    bar.appendChild(next);

    const sync = (): void => {
      const max = strip.scrollWidth - strip.clientWidth;
      bar.classList.toggle("is-scrollable", max > 1);
      prev.disabled = strip.scrollLeft <= 1;
      next.disabled = strip.scrollLeft >= max - 1;
    };
    prev.addEventListener("click", () => strip.scrollBy({ left: -strip.clientWidth, behavior: "smooth" }));
    next.addEventListener("click", () => strip.scrollBy({ left: strip.clientWidth, behavior: "smooth" }));
    strip.addEventListener("scroll", sync, { passive: true });
    sync();
  }

  private remove(): void {
    this.disconnectObserver();
    // The panel is anchored to a button that is about to go away, and it holds
    // `document` listeners of its own: left open it would sit over the editor
    // with nothing left that could dismiss it.
    closeToolbarColorPicker();
    document.querySelectorAll(".mtk-editor-toolbar").forEach((el) => el.remove());
  }

  private disconnectObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
