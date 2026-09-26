import { TFile, normalizePath } from "obsidian";
import { ENCRYPTED_FILE_EXTENSION_ENC } from "./Constants";

export class Utils{

	public static getFilePathWithNewExtension( file: TFile, newExtension : string ) : string {
		return normalizePath( `${file.parent?.path}/${file.basename}.${newExtension}` )
	}

	public static getFilePathExcludingExtension( file: TFile ) : string {
		return normalizePath( `${file.parent?.path}/${file.basename}` );
	}

	/**
	 * 加密后的文件路径：保留原始文件名（含原扩展名），仅追加 `.enc` 后缀。
	 * 例：`未命名.md` → `未命名.md.enc`，使加密后仍能从文件名看出原始类型。
	 * 注意用 `file.name`（含扩展名）而非 `file.basename`。
	 */
	public static getEncryptedFilePath( file: TFile ) : string {
		return normalizePath( `${file.parent?.path}/${file.name}.${ENCRYPTED_FILE_EXTENSION_ENC}` )
	}

	/**
	 * 解密后的目标路径（还原原始路径）：
	 * - 新格式 `<原名>.<原ext>.enc`：去掉末尾 `.enc` 即还原（其 basename 已含原扩展名）。
	 * - 旧格式 `<原名>.mdenc` / `<原名>.encrypted`：原名无类型，还原为 `.md`。
	 */
	public static getDecryptedFilePath( file: TFile ) : string {
		if ( file.extension === ENCRYPTED_FILE_EXTENSION_ENC ) {
			return Utils.getFilePathExcludingExtension( file );
		}
		return Utils.getFilePathWithNewExtension( file, "md" );
	}

}