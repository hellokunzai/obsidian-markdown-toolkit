import { MarkdownView, TFile } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../../main";
import type { MarkdownEditorPlusSettings } from "../../../../settings";
import { IMarkdownEditorPlusPluginPluginFeature } from "../IMarkdownEditorPlusPluginPluginFeature";
import { EncryptedMarkdownView } from "./EncryptedMarkdownView";
import { ENCRYPTED_FILE_EXTENSIONS } from "../../services/Constants";

/**
 * Registers the view used to open encrypted files (.mdenc / .encrypted):
 * clicking such a file prompts for its password, then shows the decrypted
 * document. The folder-encrypt feature creates these files; this feature
 * makes them openable.
 */
export default class FeatureEncryptedView implements IMarkdownEditorPlusPluginPluginFeature {

	plugin!: MarkdownEditorPlusPlugin;

	async onload(plugin: MarkdownEditorPlusPlugin, _settings: MarkdownEditorPlusSettings): Promise<void> {
		this.plugin = plugin;

		// register the custom view for encrypted file extensions — this is
		// what makes clicking an encrypted file open the password prompt
		this.plugin.registerView(
			EncryptedMarkdownView.VIEW_TYPE,
			leaf => new EncryptedMarkdownView(leaf)
		);
		this.plugin.registerExtensions(ENCRYPTED_FILE_EXTENSIONS, EncryptedMarkdownView.VIEW_TYPE);

		// make sure an encrypted file never lands in a plain MarkdownView
		// (e.g. restored workspace layout after a restart) — swap the leaf to
		// the encrypted view type instead
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", async leaf => {
				if (leaf == null) {
					return;
				}

				if (leaf.view instanceof EncryptedMarkdownView) {
					return; // correct view already active
				}

				if (leaf.view instanceof MarkdownView) {
					const file = leaf.view.file;
					if (file == null) {
						return;
					}

					if (ENCRYPTED_FILE_EXTENSIONS.includes(file.extension)) {
						const viewState = leaf.getViewState();
						viewState.type = EncryptedMarkdownView.VIEW_TYPE;
						await leaf.setViewState(viewState);
					}
				}
			})
		);
	}

	onunload(): void {
		// Intentionally not detaching leaves here: doing so resets leaf
		// positions when the plugin reloads. EncryptedMarkdownView leaves are
		// cleaned up by Obsidian when the view type is unregistered.
	}

	buildSettingsUi(_containerEl: HTMLElement, _saveSettingCallback: () => Promise<void>): void {
		// no settings for this feature
	}
}
