import type MarkdownEditorPlusPlugin from "../../../main";
import { TFile, TextFileView } from "obsidian";
import { PasswordAndHint, SessionPasswordService } from "./SessionPasswordService";
import { FileDataHelper, JsonFileEncoding } from "./FileDataHelper";
import { Utils } from "./Utils";
import { ENCRYPTED_FILE_EXTENSION_DEFAULT } from "./Constants";

/**
 * Shared single-file encrypt/decrypt primitives reused by both the
 * single-note convert feature and the folder-bulk feature.
 */
export class FileEncryptHelper {

	/**
	 * Encrypt a plain .md file, returning the encoded encrypted file content.
	 */
	static async encryptFile(
		plugin: MarkdownEditorPlusPlugin,
		file: TFile,
		passwordAndHint: PasswordAndHint,
		content?: string
	): Promise<string> {
		// content may be passed in when the note is still only in an editor buffer
		const plainText = content ?? await plugin.app.vault.read(file);
		const encryptedData = await FileDataHelper.encrypt(passwordAndHint.password, passwordAndHint.hint, plainText);
		return JsonFileEncoding.encode(encryptedData);
	}

	/**
	 * Decrypt an encrypted file. Returns null when the password is wrong.
	 */
	static async decryptFile(plugin: MarkdownEditorPlusPlugin, file: TFile, password: string): Promise<string | null> {
		const encryptedFileContent = await plugin.app.vault.read(file);
		const encryptedData = JsonFileEncoding.decode(encryptedFileContent);
		return await FileDataHelper.decrypt(encryptedData, password);
	}

	/**
	 * Rename the file to the target extension, write the new content, and
	 * remember the password for the (new) file. Reopens the file if it was open.
	 *
	 * Pass `rememberPassword = false` when decrypting: once the content is
	 * back to plaintext the cached password is dropped instead of kept.
	 */
	static async closeUpdateRememberPasswordThenReopen(
		plugin: MarkdownEditorPlusPlugin,
		file: TFile,
		newFileExtension: string,
		content: string,
		pw: PasswordAndHint,
		rememberPassword = true
	): Promise<void> {
		let didDetach = false;

		plugin.app.workspace.iterateAllLeaves(l => {
			if (l.view instanceof TextFileView && l.view.file == file) {
							l.detach();
				didDetach = true;
			}
		});

		try {
			const newFilepath = Utils.getFilePathWithNewExtension(file, newFileExtension);
			await plugin.app.fileManager.renameFile(file, newFilepath);
			await plugin.app.vault.modify(file, content);
			if (rememberPassword) {
				SessionPasswordService.putByFile(pw, file);
			} else {
				SessionPasswordService.clearForFile(file);
			}
		} finally {
			if (didDetach) {
				await plugin.app.workspace.getLeaf(true).openFile(file);
			}
		}
	}

	/**
	 * Determine the effective encrypted extension for a freshly encrypted file.
	 */
	static get defaultEncryptedExtension(): string {
		return ENCRYPTED_FILE_EXTENSION_DEFAULT;
	}
}
