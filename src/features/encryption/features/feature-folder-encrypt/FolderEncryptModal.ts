import { App, Modal, Notice, Setting, TextComponent, TFolder } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../../main";
import { t } from "../../i18n";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService";
import { UiHelper } from "../../services/UiHelper";
import { FolderBulkService, IFolderBulkResult } from "./FolderBulkService";
import { FolderMarkService } from "./FolderMarkService";
import { EncryptedIconService } from "../../services/EncryptedIconService";

export type FolderEncryptMode = "encrypt" | "decrypt";

const ERROR_DESC_CLASS = "ve-setting-desc-error";

/**
 * Modal that lets the user pick a folder, toggle recursion and enter the
 * password in a single dialog, then runs the bulk operation.
 * The mode (encrypt / decrypt) is decided by the menu entry that opened
 * this modal — there is no in-dialog mode switch.
 */
export class FolderEncryptModal extends Modal {

	private readonly mode: FolderEncryptMode;
	private folderPath: string;
	private recursive: boolean;
	private running = false;
	private readonly plugin: MarkdownEditorPlusPlugin;

	// password form state
	private password = "";
	private confirmPass = "";
	private hint = "";

	constructor(app: App, plugin: MarkdownEditorPlusPlugin, folderPath: string, mode: FolderEncryptMode) {
		super(app);
		this.plugin = plugin;
		this.folderPath = folderPath;
		this.mode = mode;
		this.recursive = plugin.settings.featureFolderEncrypt?.recursive ?? true;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const isEncrypt = this.mode === "encrypt";
		const showConfirm = isEncrypt && this.plugin.settings.confirmPassword;

		contentEl.createEl("h2", { text: t(isEncrypt ? "modal.folderEncrypt.titleEncrypt" : "modal.folderEncrypt.titleDecrypt") });

		// Folder path (read-only plain text — no setting row, not editable)
		contentEl.createEl("p", {
			text: this.folderPath === "" ? "/" : this.folderPath,
			cls: "ve-folder-path-text"
		});

		// Recursion is driven by the plugin setting
		// (settings.folderEncrypt.recursive) — see FeatureFolderEncrypt.
		// No in-dialog toggle here on purpose.

		/* ===== Password section (merged from PluginPasswordModal) ===== */

		const focusTextOf = (setting: Setting) => {
			const elInp = setting.components.find(bc => bc instanceof TextComponent);
			if (elInp instanceof TextComponent) {
				elInp.inputEl.focus();
			}
		};

		// Main password row
		const sPassword = UiHelper.buildPasswordSetting({
			container: contentEl,
			tabIndex: 0,
			name: t("modal.password"),
			desc: t(isEncrypt ? "modal.folderEncrypt.passwordDescEncrypt" : "modal.folderEncrypt.passwordDescDecrypt"),
			placeholder: t("modal.passwordFieldPlaceholder"),
			autoFocus: true,
			onChangeCallback: (value) => {
				this.password = value;
				this.clearError(sPassword, t(isEncrypt
					? "modal.folderEncrypt.passwordDescEncrypt"
					: "modal.folderEncrypt.passwordDescDecrypt"));
			},
			onEnterCallback: (value) => {
				this.password = value;
				if (showConfirm) {
					focusTextOf(sConfirmPassword);
				} else if (isEncrypt) {
					focusTextOf(sHint);
				} else {
					void this.run(sPassword, sConfirmPassword);
				}
			}
		});

		// Confirm password row (encrypt only, when confirmPassword setting is on)
		const sConfirmPassword = UiHelper.buildPasswordSetting({
			container: contentEl,
			tabIndex: 1,
			name: t("modal.confirmPassword"),
			placeholder: t("modal.confirmPasswordFieldPlaceholder"),
			onChangeCallback: (value) => {
				this.confirmPass = value;
				this.clearError(sConfirmPassword, "");
			},
			onEnterCallback: (value) => {
				this.confirmPass = value;
				if (this.password.length > 0 && this.password === this.confirmPass) {
					focusTextOf(sHint);
				}
			}
		});
		if (!showConfirm) {
			sConfirmPassword.settingEl.hide();
		}

		// Hint row: editable when encrypting, read-only when decrypting
		const sHint = new Setting(contentEl)
			.setName(t("modal.optionalPasswordHint"))
			.addText(tc => {
				tc.inputEl.placeholder = t("modal.passwordHintFieldPlaceholder");
				tc.inputEl.tabIndex = 2;
				tc.setValue(this.hint);
				if (!isEncrypt) {
					tc.setDisabled(true);
					tc.inputEl.setAttr("readonly", true);
				}
				tc.onChange(v => this.hint = v);
				tc.inputEl.on("keypress", "*", (ev, target) => {
					if (
						ev.key === "Enter"
						&& target instanceof HTMLInputElement
					) {
						ev.preventDefault();
						void this.run(sPassword, sConfirmPassword);
					}
				});
			});
		if (!isEncrypt) {
			// Decrypt: only show if there is a hint to display
			sHint.settingEl.hide();
		}

		/* ===== End password section ===== */

		// Run / Cancel buttons
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText(t("modal.folderEncrypt.run"))
				.setCta()
				.onClick(() => void this.run(sPassword, sConfirmPassword))
			)
			.addButton(button => button
				.setButtonText(t("modal.folderEncrypt.cancel"))
				.onClick(() => this.close())
			);

		// Prefill from the session password cache (if any) so the user can
		// just hit Run without re-typing. Done async after the form is up.
		void this.prefillSessionPassword(sPassword, sHint, isEncrypt);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async prefillSessionPassword(sPassword: Setting, sHint: Setting, isEncrypt: boolean): Promise<void> {
		const files = this.collectFiles();
		if (files == null || files.length === 0) {
			return;
		}

		// Prefer the persisted folder mark hint; fall back to session cache.
		const folderMark = FolderMarkService.getMark(this.folderPath);
		const folderHint = folderMark?.hint ?? "";
		if (folderHint !== "") {
			this.hint = folderHint;
		}

		const cached: PasswordAndHint = await SessionPasswordService.getByFile(files[0]);
		if (cached.password === "") {
			// Decrypt mode: surface the stored hint as the input placeholder.
			if (!isEncrypt && this.hint !== "") {
				const tc = sPassword.components.find(bc => bc instanceof TextComponent);
				if (tc instanceof TextComponent) {
					tc.setPlaceholder(t("modal.passwordHintPlaceholder", { hint: this.hint }));
				}
			}
			return;
		}
		this.password = cached.password;
		// Session cache may carry a more recently used hint.
		if (cached.hint !== "") {
			this.hint = cached.hint;
		}
		const pwdTc = sPassword.components.find(bc => bc instanceof TextComponent);
		if (pwdTc instanceof TextComponent) {
			pwdTc.setValue(cached.password);
		}
		const hintTc = sHint.components.find(bc => bc instanceof TextComponent);
		if (hintTc instanceof TextComponent) {
			hintTc.setValue(this.hint);
		}
	}

	private showError(setting: Setting, message: string): void {
		setting.setDesc(message);
		setting.descEl.addClass(ERROR_DESC_CLASS);
	}

	private clearError(setting: Setting, defaultDesc: string): void {
		setting.setDesc(defaultDesc);
		setting.descEl.removeClass(ERROR_DESC_CLASS);
	}

	private collectFiles() {
		const abstractFile = this.app.vault.getAbstractFileByPath(this.folderPath);
		if (!(abstractFile instanceof TFolder)) {
			return null;
		}
		return this.mode === "encrypt"
			? FolderBulkService.collectPlainNotes(abstractFile, this.recursive)
			: FolderBulkService.collectEncryptedNotes(abstractFile, this.recursive);
	}

	private async run(sPassword?: Setting, sConfirmPassword?: Setting): Promise<void> {
		if (this.running) {
			return;
		}

		const isEncrypt = this.mode === "encrypt";
		const showConfirm = isEncrypt && this.plugin.settings.confirmPassword;

		const abstractFile = this.app.vault.getAbstractFileByPath(this.folderPath);
		if (!(abstractFile instanceof TFolder)) {
			new Notice(t("notice.folderNotFound"), 10000);
			return;
		}

		const files = isEncrypt
			? FolderBulkService.collectPlainNotes(abstractFile, this.recursive)
			: FolderBulkService.collectEncryptedNotes(abstractFile, this.recursive);
		if (files.length === 0) {
			new Notice(t("notice.folderNoMatchingFiles"), 8000);
			return;
		}

		// Inline password validation (previously a second modal)
		if (sPassword != null && this.password === "") {
			this.showError(sPassword, t("modal.folderEncrypt.passwordRequired"));
			const tc = sPassword.components.find(bc => bc instanceof TextComponent);
			if (tc instanceof TextComponent) {
				tc.inputEl.focus();
			}
			return;
		}
		if (showConfirm && sConfirmPassword != null && this.password !== this.confirmPass) {
			this.showError(sConfirmPassword, t("modal.passwordsDontMatch"));
			const tc = sConfirmPassword.components.find(bc => bc instanceof TextComponent);
			if (tc instanceof TextComponent) {
				tc.inputEl.focus();
			}
			return;
		}

		// Single password for the whole folder
		const passwordAndHint: PasswordAndHint = {
			password: this.password,
			hint: isEncrypt ? this.hint : ""
		};

		this.running = true;
		this.contentEl.empty();
		this.contentEl.createEl("h2", { text: t("modal.folderEncrypt.processing") });

		const summaryEl = this.contentEl.createEl("pre", {
			text: t("modal.folderEncrypt.progress", { done: "0", total: files.length.toString() }),
			cls: "meld-encrypt-pre-wrap"
		});

		let result: IFolderBulkResult = { succeeded: 0, skipped: 0, failed: 0, failedFiles: [] };

		const onProgress = (res: IFolderBulkResult, done: number, total: number) => {
			result = res;
			summaryEl.setText(
				t("modal.folderEncrypt.progress", { done: done.toString(), total: total.toString() })
				+ "\n" + t("modal.folderEncrypt.summary", {
					succeeded: res.succeeded.toString(),
					skipped: res.skipped.toString(),
					failed: res.failed.toString()
				})
			);
		};

		result = isEncrypt
			? await FolderBulkService.encrypt(this.plugin, abstractFile, this.recursive, passwordAndHint, onProgress)
			: await FolderBulkService.decrypt(this.plugin, abstractFile, this.recursive, passwordAndHint, onProgress);

		this.running = false;

		// A folder that now contains encrypted files carries the "encrypted"
		// mark: new notes are auto-encrypted and the file explorer shows the
		// lock icon. Without this the folder icon would stay unchanged after
		// a bulk encrypt (the decrypt branch below removes the mark again).
		if (isEncrypt && result.succeeded > 0) {
			const normalizedPath = FolderMarkService.normalizeFolderPath(this.folderPath);
			const wasMarked = FolderMarkService.isMarked(normalizedPath);
			FolderMarkService.addMark({
				path: normalizedPath,
				hint: passwordAndHint.hint,
				recursive: this.recursive
			});
			FolderMarkService.putPassword(normalizedPath, passwordAndHint);
			await this.plugin.saveSettings();
			EncryptedIconService.refresh();
			if (!wasMarked) {
				new Notice(t("notice.folderMarked", { path: normalizedPath }));
			}
		}

		// A fully decrypted folder becomes a normal folder again: drop its
		// encrypted-folder mark (if any) so new notes are no longer
		// auto-encrypted and the lock icon disappears. Partial failures keep
		// the mark — the folder still contains encrypted files.
		if (!isEncrypt && result.succeeded > 0 && result.failed === 0) {
			if (FolderMarkService.removeMark(this.folderPath)) {
				await this.plugin.saveSettings();
				EncryptedIconService.refresh();
				new Notice(t("notice.folderUnmarked", {
					path: FolderMarkService.normalizeFolderPath(this.folderPath)
				}));
			}
		}

		// Final summary notice
		new Notice(t("notice.folderEncryptSummary", {
			succeeded: result.succeeded.toString(),
			skipped: result.skipped.toString(),
			failed: result.failed.toString()
		}), 15000);

		if (result.failed > 0) {
			this.contentEl.createEl("h3", { text: t("modal.folderEncrypt.failedListTitle") });
			this.contentEl.createEl("pre", {
				text: result.failedFiles.join("\n"),
				cls: "meld-encrypt-pre-wrap"
			});
		}

		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText(t("modal.folderEncrypt.done"))
				.setCta()
				.onClick(() => this.close())
			);
	}

}
