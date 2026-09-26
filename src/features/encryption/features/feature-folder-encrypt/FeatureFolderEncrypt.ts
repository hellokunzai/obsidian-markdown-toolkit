import { Notice, Setting, TAbstractFile, TFile, TFolder, TextFileView } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../../main";
import { t } from "../../i18n";
import type { MarkdownEditorPlusSettings } from "../../../../settings";
import { IMarkdownEditorPlusPluginPluginFeature } from "../IMarkdownEditorPlusPluginPluginFeature";
import { FolderEncryptModal } from "./FolderEncryptModal";
import { FolderMarkService } from "./FolderMarkService";
import { IMarkedFolder } from "./IFeatureFolderEncryptSettings";
import { FolderBulkService } from "./FolderBulkService";
import { MarkFolderModal } from "./MarkFolderModal";
import { EncryptedIconService } from "../../services/EncryptedIconService";
import { ENCRYPTED_FILE_EXTENSION_DEFAULT, ENCRYPTED_FILE_EXTENSIONS } from "../../services/Constants";
import { FileEncryptHelper } from "../../services/FileEncryptHelper";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService";
import PluginPasswordModal from "../../PluginPasswordModal";

/** Give templates and "new note" flows a moment to write their content. */
const AUTO_ENCRYPT_DELAY_MS = 250;

export default class FeatureFolderEncrypt implements IMarkdownEditorPlusPluginPluginFeature {

	plugin!: MarkdownEditorPlusPlugin;
	featureSettings!: MarkdownEditorPlusSettings["featureFolderEncrypt"];

	/** Paths currently being encrypted, to avoid handling our own file renames. */
	private readonly inFlight = new Set<string>();

	/** Marked folders whose unlock modal is currently open (prevents duplicates). */
	private readonly unlocking = new Set<string>();

	async onload(plugin: MarkdownEditorPlusPlugin, settings: MarkdownEditorPlusSettings) {
		this.plugin = plugin;
		this.featureSettings = settings.featureFolderEncrypt;
		FolderMarkService.bind(this.featureSettings.markedFolders);

		// When the session remember-timer expires (or the cache is cleared
		// manually), the folder passwords are wiped via FolderMarkService's
		// clear callback. Registering our own callback *after* that lets us
		// collapse the now-locked marked folders — so "remember password time"
		// also drives an automatic re-lock of the file explorer.
		SessionPasswordService.registerClearCallback(() => {
			this.collapseLockedMarkedFolders(true);
		});

		// a folder row gets the lock icon when it is marked itself OR lives
		// inside a recursively marked folder (its notes get encrypted too)
		EncryptedIconService.start(plugin, folderPath => FolderMarkService.findMarkForParentPath(folderPath) != null);

		this.registerFolderMenu();
		this.registerCommands();
		this.registerVaultEvents();
		this.registerExplorerLock();

		// after a restart all marked folders are locked (no password in
		// memory) — collapse them so the locked state is visible and a
		// previously-expanded folder cannot be browsed without unlocking
		this.plugin.app.workspace.onLayoutReady(() => {
			this.collapseLockedMarkedFolders();
			// the file explorer renders asynchronously — run a second pass
			setTimeout(() => this.collapseLockedMarkedFolders(), 1000);
		});
	}

	onunload(): void {
		EncryptedIconService.stop();
		this.inFlight.clear();
	}

	/* ------------------------------------------------------------------ menu */

	private registerFolderMenu(): void {
		// Right-click a folder in the file explorer.
		//
		// We hook BOTH `folder-menu` and `file-menu` because Obsidian's file
		// explorer right-click on a folder only fires `file-menu` with a
		// TFolder payload — `folder-menu` is documented but does not actually
		// trigger in the file explorer. Registering only `folder-menu` results
		// in a missing menu item, even though the code "looks right".
		const addFolderMenuItems = (menu: any, folder: TFolder) => {
			const path = FolderMarkService.normalizeFolderPath(folder.path);
			const isEncrypted = FolderMarkService.isMarked(path);

			if (isEncrypted) {
				menu.addItem((item: any) => {
					item
						.setTitle(t("menu.decryptFolder"))
						.setIcon("key")
						.onClick(() => {
							new FolderEncryptModal(this.plugin.app, this.plugin, path, "decrypt").open();
						});
				});
			} else {
				menu.addItem((item: any) => {
					item
						.setTitle(t("menu.encryptFolder"))
						.setIcon("lock")
						.onClick(() => {
							new FolderEncryptModal(this.plugin.app, this.plugin, path, "encrypt").open();
						});
				});
			}
		};

		// folder-menu (kept for completeness; few versions actually fire this).
		this.plugin.registerEvent(
			this.plugin.app.workspace.on(
				"folder-menu" as any,
				((menu: any, folder: TFolder) => addFolderMenuItems(menu, folder)) as any
			)
		);

		// file-menu fires for both files and folders in the file explorer;
		// only contribute menu items when the target is a folder.
		this.plugin.registerEvent(
			this.plugin.app.workspace.on(
				"file-menu",
				(menu: any, file: any) => {
					if (file instanceof TFolder) {
						addFolderMenuItems(menu, file);
					}
				}
			)
		);
	}

	/* -------------------------------------------------------------- commands */

	private registerCommands(): void {
		const currentFolderPath = (): string => {
			const file = this.plugin.app.workspace.getActiveFile();
			const parent = file?.parent;
			return parent ? parent.path : FolderMarkService.rootPath;
		};

		// Command: bulk encrypt the folder of the currently active note.
		this.plugin.addCommand({
			id: "meld-encrypt-folder-encrypt",
			name: t("command.folderEncrypt"),
			callback: () => {
				new FolderEncryptModal(this.plugin.app, this.plugin, currentFolderPath(), "encrypt").open();
			},
		});

		this.plugin.addCommand({
			id: "meld-encrypt-folder-decrypt",
			name: t("command.folderDecrypt"),
			callback: () => {
				new FolderEncryptModal(this.plugin.app, this.plugin, currentFolderPath(), "decrypt").open();
			},
		});

		// Command: flag / un-flag the folder of the currently active note.
		this.plugin.addCommand({
			id: "meld-encrypt-toggle-mark-folder",
			name: t("command.toggleMarkFolder"),
			callback: () => {
				const path = FolderMarkService.normalizeFolderPath(currentFolderPath());
				if (FolderMarkService.isMarked(path)) {
					void this.unmarkFolder(path);
				} else {
					new MarkFolderModal(this.plugin.app, this.plugin, path).open();
				}
			},
		});
	}

	/* --------------------------------------------------------- vault events */

	private registerVaultEvents(): void {
		this.plugin.registerEvent(
			this.plugin.app.vault.on("create", (file: TAbstractFile) => {
				void this.onFileCreated(file);
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				void this.onFileRenamed(file, oldPath);
			})
		);

		this.plugin.registerEvent(
			this.plugin.app.vault.on("delete", (file: TAbstractFile) => {
				this.onFileDeleted(file);
			})
		);
	}

	private async onFileCreated(file: TAbstractFile): Promise<void> {
		if (FolderBulkService.isRunning || !(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		const mark = FolderMarkService.findMarkForParentPath(FolderMarkService.getParentPath(file.path));
		if (mark == null) {
			return;
		}

		await this.encryptNote(file, mark, AUTO_ENCRYPT_DELAY_MS);
	}

	private async onFileRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
		// folders: keep the marks in sync with the new path
		if (file instanceof TFolder) {
			if (FolderMarkService.renameFolder(oldPath, file.path)) {
				await this.plugin.saveSettings();
				EncryptedIconService.refresh();
			}
			return;
		}

		if (FolderBulkService.isRunning || !(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		// only notes moved INTO a folder are encrypted; renaming a note that
		// already lives in the folder must not encrypt it
		const oldParent = FolderMarkService.getParentPath(oldPath);
		const newParent = FolderMarkService.getParentPath(file.path);
		if (oldParent === newParent) {
			return;
		}

		// a note moved into an encrypted folder gets encrypted too
		const mark = FolderMarkService.findMarkForParentPath(newParent);
		if (mark == null) {
			return;
		}

		await this.encryptNote(file, mark, 0);
	}

	private onFileDeleted(file: TAbstractFile): void {
		if (!(file instanceof TFolder)) {
			return;
		}
		if (FolderMarkService.removeFolder(file.path)) {
			void this.plugin.saveSettings();
			EncryptedIconService.refresh();
		}
	}

	/* ------------------------------------------------ explorer expansion lock
	 *
	 * A marked folder is "locked" while its password is not in memory (e.g.
	 * after a restart). Expanding a locked marked folder in the file explorer
	 * is intercepted so the user has to unlock it first — this guarantees the
	 * password is entered (and verified) before new notes can be created,
	 * which keeps every file in the folder encrypted with the same password.
	 *
	 * The interception uses capture-phase DOM listeners on `.nav-folder-title`
	 * (which carries a data-path attribute) instead of patching Obsidian's
	 * internal file-explorer implementation, so it keeps working across
	 * Obsidian updates and on mobile.
	 */

	private registerExplorerLock(): void {
		// Obsidian's file explorer toggles the collapse arrow on
		// pointerdown/mousedown, BEFORE any click event fires. A click-only
		// capture listener therefore lets the arrow bypass the lock — the
		// folder is already expanded by the time our handler runs.
		// So pointerdown/mousedown block the expansion itself, while the
		// click handler is the one that actually prompts for the password.
		const intercept = (evt: MouseEvent) => {
			const hit = this.lockedFolderTitleFrom(evt.target);
			if (hit == null) {
				return;
			}
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.type === "click") {
				void this.promptUnlockAndExpand(hit.mark, hit.titleEl);
			}
		};
		this.plugin.registerDomEvent(document, "pointerdown", intercept, true);
		this.plugin.registerDomEvent(document, "mousedown", intercept, true);
		this.plugin.registerDomEvent(document, "click", intercept, true);

		// keyboard: ArrowRight / Enter on a focused collapsed folder title
		this.plugin.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "ArrowRight" && evt.key !== "Enter") {
				return;
			}
			if (evt.target instanceof HTMLInputElement) {
				return; // renaming a folder — never intercept
			}
			const hit = this.lockedFolderTitleFrom(evt.target);
			if (hit == null) {
				return;
			}
			evt.preventDefault();
			evt.stopPropagation();
			void this.promptUnlockAndExpand(hit.mark, hit.titleEl);
		}, true);
	}

	/**
	 * Resolve a DOM event target to a locked marked folder's title element.
	 * Returns null when the event is not an expand attempt on a locked
	 * marked folder (collapse is always allowed).
	 */
	private lockedFolderTitleFrom(target: EventTarget | null): { mark: IMarkedFolder; titleEl: HTMLElement } | null {
		// NOTE: the collapse arrow contains an <svg>/<path> — those are
		// SVGElement, NOT HTMLElement. Checking `instanceof HTMLElement`
		// here would silently let every arrow click bypass the lock.
		if (!(target instanceof Element)) {
			return null;
		}
		let titleEl: HTMLElement | null = target.closest(".nav-folder-title");
		if (!(titleEl instanceof HTMLElement)) {
			// fallback: some themes/versions render the collapse arrow
			// outside .nav-folder-title — resolve the title via the
			// indicator so the arrow cannot bypass the lock either
			const indicator = target.closest(".nav-folder-collapse-indicator");
			if (indicator instanceof HTMLElement) {
				const candidate = indicator.closest(".nav-folder")?.querySelector(":scope > .nav-folder-title");
				if (candidate instanceof HTMLElement) {
					titleEl = candidate;
				}
			}
			if (!(titleEl instanceof HTMLElement)) {
				return null;
			}
		}
		// only inside the file explorer (not e.g. another plugin's nav tree)
		if (titleEl.closest('.workspace-leaf-content[data-type="file-explorer"]') == null) {
			return null;
		}
		if (!this.isFolderTitleCollapsed(titleEl)) {
			return null; // already expanded → this is a collapse, allow it
		}
		const path = titleEl.getAttribute("data-path");
		if (path == null) {
			return null;
		}
		// expanding a folder covered by a mark (the marked folder itself or a
		// sub-folder of a recursive mark) requires that mark to be unlocked
		const mark = FolderMarkService.findMarkForParentPath(FolderMarkService.normalizeFolderPath(path));
		if (mark == null || FolderMarkService.hasPassword(mark.path)) {
			return null;
		}
		return { mark, titleEl };
	}

	private isFolderTitleCollapsed(titleEl: HTMLElement): boolean {
		return titleEl.classList.contains("is-collapsed")
			|| titleEl.parentElement?.classList.contains("is-collapsed") === true;
	}

	/** Ask for the folder password (verified), then expand the folder. */
	private async promptUnlockAndExpand(mark: IMarkedFolder, titleEl: HTMLElement): Promise<void> {
		if (FolderMarkService.hasPassword(mark.path)) {
			titleEl.click();
			return;
		}
		if (this.unlocking.has(mark.path)) {
			return; // a modal for this folder is already open
		}
		this.unlocking.add(mark.path);
		try {
			const result = await this.promptVerifiedPassword(mark, t("modal.unlockFolder.title"));
			if (result != null) {
				EncryptedIconService.refresh();
				// replay the click — the guard above now lets it through
				titleEl.click();
			}
		} finally {
			this.unlocking.delete(mark.path);
		}
	}

	/**
	 * Collapse every marked folder that is currently locked (no password in
	 * memory). Used both on startup (silent) and on session clear / password
	 * timeout (with a notice when `notify` is set).
	 */
	private collapseLockedMarkedFolders(notify = false): void {
		const titles = document.querySelectorAll<HTMLElement>(
			'.workspace-leaf-content[data-type="file-explorer"] .nav-folder-title[data-path]'
		);
		let collapsed = 0;
		titles.forEach((titleEl) => {
			if (this.isFolderTitleCollapsed(titleEl)) {
				return;
			}
			const path = titleEl.getAttribute("data-path");
			if (path == null) {
				return;
			}
			// only collapse the marked folder itself — collapsing it already
			// hides every sub-folder underneath it
			const mark = FolderMarkService.getMark(path);
			if (mark == null || FolderMarkService.hasPasswordInMemory(mark.path)) {
				return;
			}
			titleEl.click(); // collapse is never blocked by the lock
			collapsed++;
		});
		if (notify && collapsed > 0) {
			new Notice(t("notice.folderAutoLockOnTimeout"));
		}
	}

	/* ------------------------------------------------------- marking actions */

	private async unmarkFolder(folderPath: string): Promise<void> {
		if (!FolderMarkService.removeMark(folderPath)) {
			return;
		}
		await this.plugin.saveSettings();
		EncryptedIconService.refresh();
		new Notice(t("notice.folderUnmarked", { path: folderPath }));
	}

	/* -------------------------------------------------------- encrypt a note */

	private async encryptNote(file: TFile, mark: IMarkedFolder, delayMs: number): Promise<void> {
		const originalPath = file.path;
		// the TFile is renamed in place, so remember the original name for notices
		const displayName = file.name;

		if (this.inFlight.has(originalPath)) {
			return;
		}
		this.inFlight.add(originalPath);

		try {
			// let "new note" / template flows write their content first
			if (delayMs > 0) {
				await this.delay(delayMs);
			}

			if (this.plugin.app.vault.getAbstractFileByPath(file.path) == null) {
				return;
			}

			const passwordAndHint = await this.resolvePassword(mark);
			if (passwordAndHint == null) {
				new Notice(t("notice.autoEncryptSkipped", { name: displayName }), 10000);
				return;
			}

			const content = await this.readNoteContent(file);
			const encryptedContent = await FileEncryptHelper.encryptFile(
				this.plugin,
				file,
				passwordAndHint,
				content
			);

			await FileEncryptHelper.closeUpdateRememberPasswordThenReopen(
				this.plugin,
				file,
				ENCRYPTED_FILE_EXTENSION_DEFAULT,
				encryptedContent,
				passwordAndHint
			);

			FolderMarkService.putPassword(mark.path, passwordAndHint);
			EncryptedIconService.refresh();
			new Notice(t("notice.autoEncrypted", { name: displayName }));
		} catch (error) {
			console.error("vault-encrypt: unable to auto encrypt note", { path: originalPath, error });
			new Notice(t("notice.autoEncryptFailed", { name: displayName }), 10000);
		} finally {
			this.inFlight.delete(originalPath);
		}
	}

	/**
	 * Content of a note, preferring the in-memory editor buffer so text that
	 * has not been flushed to disk yet is encrypted as well.
	 */
	private async readNoteContent(file: TFile): Promise<string> {
		let buffer: string | null = null;
		this.plugin.app.workspace.iterateAllLeaves(leaf => {
			const view = leaf.view;
			if (view instanceof TextFileView && view.file === file) {
				buffer = view.data;
			}
		});
		return buffer ?? await this.plugin.app.vault.read(file);
	}

	/**
	 * Password for a marked folder: in-memory cache first, then ask the user
	 * once (Q2). The password is never written to disk.
	 */
	private async resolvePassword(mark: IMarkedFolder): Promise<PasswordAndHint | null> {
		const cached = FolderMarkService.getPassword(mark.path);
		if (cached.password !== "") {
			return cached;
		}
		return await this.promptVerifiedPassword(mark, t("modal.autoEncryptPassword.title"));
	}

	/**
	 * Ask the user for a marked folder's password and only accept it once it
	 * has been verified: when the folder already contains encrypted files,
	 * the password must successfully decrypt one of them. This prevents a
	 * mistyped (or brand-new) password from being cached after a restart and
	 * producing files whose password differs from the rest of the folder.
	 *
	 * When the folder does not contain any encrypted file yet, any password
	 * is accepted — it becomes the folder's first password.
	 */
	private async promptVerifiedPassword(mark: IMarkedFolder, title: string): Promise<PasswordAndHint | null> {
		const sample = this.findEncryptedSample(mark);

		for (;;) {
			const modal = new PluginPasswordModal(
				this.plugin.app,
				title,
				sample == null, // encrypting (hint editable) only when setting the folder's first password
				false, // no confirmation when re-entering an existing password
				{ password: "", hint: mark.hint }
			);

			const result = await modal.open2Async();
			if (result == null || result.password === "") {
				return null; // user cancelled
			}

			if (sample == null || await this.verifyPassword(sample, result.password)) {
				FolderMarkService.putPassword(mark.path, result);
				return result;
			}

			new Notice(t("notice.folderPasswordWrong"), 8000);
		}
	}

	/**
	 * Find one encrypted file whose covering mark is exactly this mark, to
	 * verify a candidate password against. Files covered by a more specific
	 * (nested) mark belong to that mark's password and are ignored.
	 */
	private findEncryptedSample(mark: IMarkedFolder): TFile | null {
		for (const file of this.plugin.app.vault.getFiles()) {
			if (!ENCRYPTED_FILE_EXTENSIONS.includes(file.extension)) {
				continue;
			}
			const covering = FolderMarkService.findMarkForParentPath(FolderMarkService.getParentPath(file.path));
			if (covering === mark) {
				return file;
			}
		}
		return null;
	}

	/** True when the password successfully decrypts the sample file. */
	private async verifyPassword(sampleFile: TFile, password: string): Promise<boolean> {
		try {
			return await FileEncryptHelper.decryptFile(this.plugin, sampleFile, password) != null;
		} catch (error) {
			console.warn("vault-encrypt: unable to verify password against sample file", { path: sampleFile.path, error });
			return false;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise<void>(resolve => setTimeout(resolve, ms));
	}

	/* -------------------------------------------------------------- settings */

	buildSettingsUi(containerEl: HTMLElement, saveSettingCallback: () => Promise<void>): void {
		const sectionEl = containerEl.createDiv({ cls: "ve-folder-encrypt-settings" });

		sectionEl.createEl("h3", { text: t("settings.folderEncrypt.heading") });

		new Setting(sectionEl)
			.setName(t("settings.folderEncrypt.recursive.name"))
			.setDesc(t("settings.folderEncrypt.recursive.desc"))
			.addToggle(toggle => toggle
				.setValue(this.featureSettings.recursive)
				.onChange(async value => {
					this.featureSettings.recursive = value;
					await saveSettingCallback();
				})
			);

	}
}
