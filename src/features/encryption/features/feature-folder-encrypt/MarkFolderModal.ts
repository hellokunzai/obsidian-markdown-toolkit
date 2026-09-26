import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../../main";
import { t } from "../../i18n";
import { UiHelper } from "../../services/UiHelper";
import { PasswordAndHint } from "../../services/SessionPasswordService";
import { FolderBulkService } from "./FolderBulkService";
import { FolderMarkService } from "./FolderMarkService";

/**
 * Dialog shown when a folder is flagged as "encrypted".
 *
 * Asks for the password (kept in memory only) and lets the user decide whether
 * the notes already living in the folder should be encrypted right away.
 */
export class MarkFolderModal extends Modal {

	private readonly plugin: MarkdownEditorPlusPlugin;
	private folderPath: string;
	private recursive: boolean;

	private password = "";
	private confirmPassword = "";
	private hint = "";
	private encryptExisting = true;

	private sConfirmPassword: Setting | null = null;

	constructor(app: App, plugin: MarkdownEditorPlusPlugin, folderPath: string) {
		super(app);
		this.plugin = plugin;
		this.folderPath = FolderMarkService.normalizeFolderPath(folderPath);
		this.recursive = plugin.settings.featureFolderEncrypt?.recursive ?? true;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: t("modal.markFolder.title") });
		contentEl.createEl("p", { text: t("modal.markFolder.desc") });
		contentEl.createEl("p", { text: t("modal.markFolder.descNoPasswordStored") });

		// Folder path (read-only plain text — no setting row, not editable)
		contentEl.createEl("p", {
			text: this.folderPath === "" ? "/" : this.folderPath,
			cls: "ve-folder-path-text"
		});

		// Password
		UiHelper.buildPasswordSetting({
			container: contentEl,
			name: t("modal.password"),
			placeholder: t("modal.passwordFieldPlaceholder"),
			autoFocus: true,
			onChangeCallback: value => {
				this.password = value;
			},
			onEnterCallback: () => this.confirm()
		});

		// Confirm password (only when the plugin asks for confirmation)
		this.sConfirmPassword = UiHelper.buildPasswordSetting({
			container: contentEl,
			name: t("modal.confirmPassword"),
			placeholder: t("modal.confirmPasswordFieldPlaceholder"),
			onChangeCallback: value => {
				this.confirmPassword = value;
			},
			onEnterCallback: () => this.confirm()
		});

		if (!this.plugin.settings.confirmPassword) {
			this.sConfirmPassword.settingEl.hide();
		}

		// Optional hint
		new Setting(contentEl)
			.setName(t("modal.optionalPasswordHint"))
			.addText(text => {
				text.inputEl.placeholder = t("modal.passwordHintFieldPlaceholder");
				text.onChange(value => {
					this.hint = value;
				});
			});

		// Recursion is driven by the plugin setting
		// (settings.folderEncrypt.recursive) — see FeatureFolderEncrypt.
		// No in-dialog toggle here on purpose.

		// Encrypt notes that are already in the folder
		new Setting(contentEl)
			.setName(t("modal.markFolder.encryptExisting"))
			.setDesc(t("modal.markFolder.encryptExistingDesc"))
			.addToggle(toggle => toggle
				.setValue(this.encryptExisting)
				.onChange(value => {
					this.encryptExisting = value;
				})
			);

		// Buttons
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText(t("modal.markFolder.confirm"))
				.setCta()
				.onClick(() => this.confirm())
			)
			.addButton(button => button
				.setButtonText(t("modal.folderEncrypt.cancel"))
				.onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private confirm(): void {
		if (this.password.length === 0) {
			new Notice(t("notice.passwordRequired"));
			return;
		}

		if (this.plugin.settings.confirmPassword) {
			if (this.password !== this.confirmPassword) {
				this.sConfirmPassword?.setDesc(t("modal.passwordsDontMatch"));
				return;
			}
			this.sConfirmPassword?.setDesc("");
		}

		const folderPath = this.folderPath;
		const passwordAndHint: PasswordAndHint = { password: this.password, hint: this.hint };

		this.close();

		void this.commit(folderPath, passwordAndHint, this.recursive, this.encryptExisting);
	}

	private async commit(
		folderPath: string,
		passwordAndHint: PasswordAndHint,
		recursive: boolean,
		encryptExisting: boolean
	): Promise<void> {
		FolderMarkService.addMark({ path: folderPath, hint: passwordAndHint.hint, recursive });
		FolderMarkService.putPassword(folderPath, passwordAndHint);
		await this.plugin.saveSettings();

		new Notice(t("notice.folderMarked", { path: folderPath }));

		if (!encryptExisting) {
			return;
		}

		const abstractFile = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(abstractFile instanceof TFolder)) {
			return;
		}

		const result = await FolderBulkService.encrypt(this.plugin, abstractFile, recursive, passwordAndHint);

		new Notice(t("notice.folderEncryptSummary", {
			succeeded: result.succeeded.toString(),
			skipped: result.skipped.toString(),
			failed: result.failed.toString()
		}), 15000);

		if (result.failed > 0) {
			console.error("vault-encrypt: unable to encrypt some notes", result.failedFiles);
		}
	}
}
