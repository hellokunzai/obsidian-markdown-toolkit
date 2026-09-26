import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import type MarkdownEditorPlusPlugin from "../../../../main";
import { IFeatureRandomPasswordSettings } from "./IFeatureRandomPasswordSettings";

// Character pools used to build the random password.
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const NUMBER = "0123456789";
const SYMBOL = "!@#$%^&*()-_=+[]{};:,.<>?";

/**
 * Generate a cryptographically random password.
 * Uses crypto.getRandomValues (available on desktop and mobile).
 * Guarantees at least one character from every enabled pool.
 */
export function generateRandomPassword(settings: IFeatureRandomPasswordSettings): string {
	const pools: string[] = [];
	if (settings.upper) pools.push(UPPER);
	if (settings.lower) pools.push(LOWER);
	if (settings.number) pools.push(NUMBER);
	if (settings.symbol) pools.push(SYMBOL);

	if (pools.length === 0) {
		// Nothing selected: fall back to a safe default so we never return empty.
		pools.push(LOWER + NUMBER);
	}

	const all = pools.join("");
	const length = Math.max(1, settings.length);

	const cryptoObj = (globalThis.crypto ?? (window as unknown as { crypto: Crypto }).crypto);
	const randomBytes = new Uint32Array(length);
	cryptoObj.getRandomValues(randomBytes);

	let result = "";
	for (let i = 0; i < length; i++) {
		result += all.charAt(randomBytes[i] % all.length);
	}

	// Guarantee at least one char from each enabled pool by overwriting slots.
	let pos = 0;
	for (const pool of pools) {
		const idx = randomBytes[pos % length] % pool.length;
		result = result.substring(0, pos % length) + pool.charAt(idx) + result.substring((pos % length) + 1);
		pos++;
	}

	return result;
}

export default class RandomPasswordModal extends Modal {
	plugin: MarkdownEditorPlusPlugin;
	settings: IFeatureRandomPasswordSettings;

	constructor(app: App, plugin: MarkdownEditorPlusPlugin, settings: IFeatureRandomPasswordSettings) {
		super(app);
		this.plugin = plugin;
		this.settings = { ...settings };
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.classList.add("meld-encrypt-random-password-modal");

		contentEl.createEl("h2", { text: t("modal.generatePassword.title") });

		// --- Length setting ---
		new Setting(contentEl)
			.setName(t("modal.generatePassword.length.name"))
			.setDesc(t("modal.generatePassword.length.desc"))
			.addText((text) =>
				text
					.setPlaceholder("16")
					.setValue(this.settings.length.toString())
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 1 && n <= 256) {
							this.settings.length = n;
						}
					})
			);

		// --- Character class toggles ---
		const addToggle = (key: "upper" | "lower" | "number" | "symbol", nameKey: string) => {
			new Setting(contentEl)
				.setName(t(`modal.generatePassword.${nameKey}.name`))
				.addToggle((toggle) =>
					toggle.setValue(this.settings[key]).onChange((value) => {
						this.settings[key] = value;
					})
				);
		};
		addToggle("upper", "upper");
		addToggle("lower", "lower");
		addToggle("number", "number");
		addToggle("symbol", "symbol");

		// --- Result area ---
		const resultEl = contentEl.createEl("textarea", {
			cls: "meld-encrypt-random-password-result",
			attr: { rows: "3", readonly: "true" },
		});
		resultEl.value = generateRandomPassword(this.settings);

		// --- Actions ---
		const sActions = new Setting(contentEl);

		sActions.addButton((cb) =>
			cb
				.setButtonText(t("modal.generatePassword.regenerate"))
				.onClick(() => {
					resultEl.value = generateRandomPassword(this.settings);
				})
		);

		sActions.addButton((cb) =>
			cb
				.setButtonText(t("modal.generatePassword.copy"))
				.onClick(() => {
					navigator.clipboard.writeText(resultEl.value);
					new Notice(t("notice.copied"));
				})
		);

		sActions.addButton((cb) =>
			cb
				.setButtonText(t("modal.generatePassword.done"))
				.onClick(() => this.close())
		);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// Persist the chosen settings for next time.
		this.plugin.settings.featureRandomPassword = { ...this.settings };
		void this.plugin.saveSettings();
	}
}
