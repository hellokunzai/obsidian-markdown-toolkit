import type MarkdownEditorPlusPlugin from "../../../main";
import type { MarkdownEditorPlusSettings } from "../../../settings";

export interface IMarkdownEditorPlusPluginPluginFeature {
	onload(plugin: MarkdownEditorPlusPlugin, settings: MarkdownEditorPlusSettings): Promise<void>;
	onunload(): void;
	buildSettingsUi(
		containerEl: HTMLElement,
		saveSettingCallback : () => Promise<void>
	) : void;
}
