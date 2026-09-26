import { TFile, TFolder } from "obsidian";
import type MarkdownEditorPlusPlugin from "../../../../main";
import { t } from "../../i18n";
import { ENCRYPTED_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSION_DEFAULT } from "../../services/Constants";
import { FileEncryptHelper } from "../../services/FileEncryptHelper";
import { PasswordAndHint } from "../../services/SessionPasswordService";

export interface IFolderBulkResult {
	succeeded: number;
	skipped: number;
	failed: number;
	failedFiles: string[];
}

export type FolderBulkProgressCallback = (result: IFolderBulkResult, done: number, total: number) => void;

/**
 * Bulk encrypt / decrypt of every matching file inside a folder.
 *
 * Shared by the folder encrypt dialog, the "mark folder" dialog and the
 * context-menu action for encrypting notes that predate the mark.
 */
export class FolderBulkService {

	/**
	 * True while a bulk folder operation runs. The auto-encrypt feature must
	 * ignore the file renames these operations cause, otherwise decrypting a
	 * marked folder would instantly re-encrypt every note.
	 */
	private static running = false;

	static get isRunning(): boolean {
		return FolderBulkService.running;
	}

	static collectFiles(folder: TFolder, recursive: boolean, targetExtensions: string[]): TFile[] {
		const result: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (recursive) {
					result.push(...FolderBulkService.collectFiles(child, recursive, targetExtensions));
				}
			} else if (child instanceof TFile) {
				if (targetExtensions.contains(child.extension)) {
					result.push(child);
				}
			}
		}
		return result;
	}

	static collectPlainNotes(folder: TFolder, recursive: boolean): TFile[] {
		return FolderBulkService.collectFiles(folder, recursive, ["md"]);
	}

	static collectEncryptedNotes(folder: TFolder, recursive: boolean): TFile[] {
		return FolderBulkService.collectFiles(folder, recursive, ENCRYPTED_FILE_EXTENSIONS.slice());
	}

	static async encrypt(
		plugin: MarkdownEditorPlusPlugin,
		folder: TFolder,
		recursive: boolean,
		passwordAndHint: PasswordAndHint,
		onProgress?: FolderBulkProgressCallback
	): Promise<IFolderBulkResult> {
		return await FolderBulkService.run(
			FolderBulkService.collectPlainNotes(folder, recursive),
			async file => {
				const encryptedContent = await FileEncryptHelper.encryptFile(plugin, file, passwordAndHint);
				await FileEncryptHelper.closeUpdateRememberPasswordThenReopen(
					plugin,
					file,
					ENCRYPTED_FILE_EXTENSION_DEFAULT,
					encryptedContent,
					passwordAndHint
				);
			},
			onProgress
		);
	}

	static async decrypt(
		plugin: MarkdownEditorPlusPlugin,
		folder: TFolder,
		recursive: boolean,
		passwordAndHint: PasswordAndHint,
		onProgress?: FolderBulkProgressCallback
	): Promise<IFolderBulkResult> {
		return await FolderBulkService.run(
			FolderBulkService.collectEncryptedNotes(folder, recursive),
			async file => {
				const content = await FileEncryptHelper.decryptFile(plugin, file, passwordAndHint.password);
				if (content == null) {
					throw new Error(t("error.decryptionFailed"));
				}
				await FileEncryptHelper.closeUpdateRememberPasswordThenReopen(
					plugin,
					file,
					"md",
					content,
					passwordAndHint,
					false
				);
			},
			onProgress
		);
	}

	private static async run(
		files: TFile[],
		process: (file: TFile) => Promise<void>,
		onProgress?: FolderBulkProgressCallback
	): Promise<IFolderBulkResult> {
		const result: IFolderBulkResult = { succeeded: 0, skipped: 0, failed: 0, failedFiles: [] };

		FolderBulkService.running = true;
		try {
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				try {
					await process(file);
					result.succeeded++;
				} catch (error) {
					console.error("vault-encrypt: folder bulk operation failed", { path: file.path, error });
					result.failed++;
					result.failedFiles.push(file.path);
				}
				onProgress?.(result, i + 1, files.length);
			}
		} finally {
			FolderBulkService.running = false;
		}

		return result;
	}
}
