import { type App } from "obsidian";
import { containerFolderPath, explorerRootEl, itemName } from "./explorer-paths";
import type MarkdownEditorPlusPlugin from "../main";

/**
 * Manual file/folder ordering in the file explorer.
 *
 * When enabled, every `.nav-folder-children` is re-ordered to match a stored
 * per-folder list. Drag handles let the user reorder items; the new order is
 * persisted after each drag.
 *
 * Dragging uses pointer events rather than the native HTML5 drag-and-drop, so
 * it never collides with Obsidian's own "drag a file onto a folder to move it"
 * behaviour — only our handle is interactive, and nothing is moved on disk.
 */
export class FileOrder {
  private readonly plugin: MarkdownEditorPlusPlugin;
  private readonly app: App;
  private readonly observers = new Set<MutationObserver>();
  private dragging = false;

  constructor(plugin: MarkdownEditorPlusPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  enable(): void {
    // Registered so Obsidian drops the listener on plugin unload, avoiding
    // callbacks against a torn-down workspace.
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.attach()));
    this.attach();
  }

  private attach(): void {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const root = explorerRootEl(leaf);
      if (!root) continue;
      if (root.dataset.mtkOrderBound) continue;
      root.dataset.mtkOrderBound = "1";
      const observer = new MutationObserver(() => {
        if (!this.dragging) this.applyAll();
      });
      observer.observe(root, { childList: true, subtree: true });
      this.observers.add(observer);
    }
    this.applyAll();
  }

  /** Re-order every folder whose children are currently in the DOM. */
  private applyAll(): void {
    if (!this.plugin.settings.orderEnabled) return;
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const root = explorerRootEl(leaf);
      if (!root) continue;
      // `>` is safe here: the root folder's own children container is a child of
      // the root row, and every nested one is a child of its own folder row.
      const containers = root.querySelectorAll<HTMLElement>(".nav-folder-children");
      containers.forEach((container) => {
        this.applyOrder(container);
        this.bindContainer(container);
      });
    }
  }

  /** Resolve the folder path a container belongs to ("" for the vault root). */
  private folderPathOf(container: HTMLElement): string {
    return containerFolderPath(container);
  }

  private applyOrder(container: HTMLElement): void {
    const folderPath = this.folderPathOf(container);
    const order = this.plugin.settings.orderMap[folderPath];
    if (!order || order.length === 0) return;

    const children = Array.from(container.children) as HTMLElement[];
    const byName = new Map<string, HTMLElement>();
    for (const child of children) byName.set(itemName(child), child);

    let anchor: HTMLElement | null = null;
    for (const name of order) {
      const child = byName.get(name);
      if (!child) continue;
      if (anchor) container.insertBefore(child, anchor.nextSibling);
      else container.insertBefore(child, container.firstChild);
      anchor = child;
    }
  }

  /** Ensure each child has a drag handle and wire up the drag interaction. */
  private bindContainer(container: HTMLElement): void {
    const children = Array.from(container.children) as HTMLElement[];
    for (const child of children) {
      // Check the live DOM rather than a flag on the item: Obsidian may
      // re-render the title element (dropping the old handle) while keeping the
      // item node, and a stale flag would then suppress the re-add.
      const title = child.querySelector(".nav-file-title, .nav-folder-title") ?? child;
      if (title.querySelector(".mtk-order-handle")) continue;

      // `createSpan` off the container rather than `document.createElement`:
      // the element is created in the document the row belongs to, so a handle
      // added in a popout window is a node of that window.
      const handle = container.createSpan("mtk-order-handle");
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (e) => this.beginDrag(child, e));
      // Prepend so it sits at the left of the title row.
      title.insertBefore(handle, title.firstChild);
    }
  }

  private beginDrag(source: HTMLElement, event: PointerEvent): void {
    if (!this.plugin.settings.orderEnabled) return;
    event.preventDefault();
    this.dragging = true;
    source.classList.add("mtk-dragging");

    const container = source.parentElement as HTMLElement;
    // A popout window has its own `window` and `document`: the pointer events
    // and the hit test both have to come from the document the row lives in, or
    // dragging in a popout would do nothing at all.
    const win = container.ownerDocument.defaultView ?? window;
    const move = (e: PointerEvent): void => {
      const target = this.itemUnderPoint(e.clientX, e.clientY, container, source);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      if (after) container.insertBefore(source, target.nextSibling);
      else container.insertBefore(source, target);
    };

    const up = (): void => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      source.classList.remove("mtk-dragging");
      this.dragging = false;
      this.writeOrder(container);
      this.applyAll();
    };

    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
  }

  /** Find the sibling item under a point, ignoring the dragged element. */
  private itemUnderPoint(
    x: number,
    y: number,
    container: HTMLElement,
    source: HTMLElement
  ): HTMLElement | null {
    const el = container.ownerDocument.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    let item: HTMLElement | null = el.closest(".nav-file, .nav-folder");
    while (item && item.parentElement !== container) item = item.parentElement;
    if (!item || item === source) return null;
    return item;
  }

  /** Persist the current order of a folder container. */
  private writeOrder(container: HTMLElement): void {
    const folderPath = this.folderPathOf(container);
    const names: string[] = [];
    for (const child of Array.from(container.children) as HTMLElement[]) {
      const name = itemName(child);
      if (name) names.push(name);
    }
    const orderMap = { ...this.plugin.settings.orderMap, [folderPath]: names };
    this.plugin.settings.orderMap = orderMap;
    void this.plugin.saveSettings();
  }
}
