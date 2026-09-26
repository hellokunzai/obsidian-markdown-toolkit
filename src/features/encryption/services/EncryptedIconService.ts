import { TAbstractFile } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../main";
import { ENCRYPTED_FILE_EXTENSIONS } from "./Constants";

/**
 * Marks encrypted files and flagged "encrypted" folders in the file explorer.
 *
 * The service itself only toggles CSS classes on the explorer rows
 * (`.ve-encrypted-file` / `.ve-marked-folder`); the actual lock glyph is
 * drawn purely by CSS (see styles.css). This is deliberate: themes and icon
 * plugins render their folder/file glyphs in many different ways (real icon
 * elements, `::before` pseudo elements, background images), so any DOM
 * manipulation ends up fighting the theme and produces duplicate icons.
 * CSS overrides win regardless of how the glyph was rendered, and removing
 * the class fully restores the theme look — no restore bookkeeping needed.
 *
 * The explorer is re-rendered constantly, so the DOM is re-checked on
 * layout changes, vault changes and explorer mutations.
 */
export class EncryptedIconService {

	private static readonly FILE_ROW_CLASS = "ve-encrypted-file";
	private static readonly FOLDER_ROW_CLASS = "ve-marked-folder";

	private static observer: MutationObserver | null = null;
	private static observedEl: Element | null = null;
	private static refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private static started = false;

	/** Injected by the folder feature: does this folder carry an "encrypted" mark? */
	private static isMarkedFolder: (folderPath: string) => boolean = () => false;

	static start(plugin: MarkdownEditorPlusPlugin, isMarkedFolder: (folderPath: string) => boolean): void {
		if (EncryptedIconService.started) {
			return;
		}
		EncryptedIconService.started = true;
		EncryptedIconService.isMarkedFolder = isMarkedFolder;

		const requestRefresh = () => EncryptedIconService.requestRefresh();

		plugin.registerEvent(plugin.app.workspace.on("layout-change", requestRefresh));
		plugin.registerEvent(plugin.app.vault.on("create", requestRefresh));
		plugin.registerEvent(plugin.app.vault.on("rename", (_file: TAbstractFile) => requestRefresh()));
		plugin.registerEvent(plugin.app.vault.on("delete", (_file: TAbstractFile) => requestRefresh()));

		// first pass, and keep watching the explorer for re-renders
		requestRefresh();
	}

	static stop(): void {
		EncryptedIconService.started = false;
		EncryptedIconService.isMarkedFolder = () => false;
		if (EncryptedIconService.refreshTimer != null) {
			clearTimeout(EncryptedIconService.refreshTimer);
			EncryptedIconService.refreshTimer = null;
		}
		EncryptedIconService.observer?.disconnect();
		EncryptedIconService.observer = null;
		EncryptedIconService.observedEl = null;

		document
			.querySelectorAll(`.${EncryptedIconService.FILE_ROW_CLASS}, .${EncryptedIconService.FOLDER_ROW_CLASS}`)
			.forEach(el => {
				el.classList.remove(EncryptedIconService.FILE_ROW_CLASS, EncryptedIconService.FOLDER_ROW_CLASS);
			});
	}

	/** Re-apply icons, e.g. right after a folder mark was added or removed. */
	static refresh(): void {
		EncryptedIconService.requestRefresh();
	}

	private static requestRefresh(): void {
		if (EncryptedIconService.refreshTimer != null) {
			clearTimeout(EncryptedIconService.refreshTimer);
		}
		EncryptedIconService.refreshTimer = setTimeout(
			() => {
				EncryptedIconService.refreshTimer = null;
				EncryptedIconService.apply();
			},
			50
		);
	}

	private static apply(): void {
		EncryptedIconService.watchExplorer();

		const rows = document.querySelectorAll<HTMLElement>(".nav-file-title[data-path], .nav-folder-title[data-path]");
		rows.forEach(row => EncryptedIconService.applyToRow(row));

		// our own DOM writes queue mutations we don't care about
		EncryptedIconService.observer?.takeRecords();
	}

	private static watchExplorer(): void {
		const container = document.querySelector(".nav-files-container");
		if (container == null || container === EncryptedIconService.observedEl) {
			return;
		}
		EncryptedIconService.observer?.disconnect();
		EncryptedIconService.observer = new MutationObserver(() => EncryptedIconService.requestRefresh());
		EncryptedIconService.observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
		EncryptedIconService.observedEl = container;
	}

	private static applyToRow(row: HTMLElement): void {
		const path = row.getAttribute("data-path") ?? "";
		const isFileRow = row.classList.contains("nav-file-title");

		if (isFileRow) {
			row.classList.toggle(EncryptedIconService.FILE_ROW_CLASS, EncryptedIconService.isEncryptedPath(path));
		} else {
			row.classList.toggle(EncryptedIconService.FOLDER_ROW_CLASS, EncryptedIconService.isMarkedFolder(path));
		}
	}

	private static isEncryptedPath(path: string): boolean {
		const lower = path.toLowerCase();
		return ENCRYPTED_FILE_EXTENSIONS.some(ext => lower.endsWith(`.${ext}`));
	}
}
