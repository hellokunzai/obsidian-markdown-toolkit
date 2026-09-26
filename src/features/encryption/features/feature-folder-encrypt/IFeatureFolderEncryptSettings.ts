/**
 * A folder that has been flagged as "encrypted": every .md note created or
 * moved into it is encrypted automatically.
 *
 * The password itself is never persisted — only the (optional) hint is.
 */
export interface IMarkedFolder {
	/** Vault-relative folder path. "/" means the vault root. */
	path: string;
	/** Optional password hint, shown when the password is asked for again. */
	hint: string;
	/** When true, sub-folders are covered by this mark too. */
	recursive: boolean;
}

export type EncryptScope = "md" | "all";

export interface IFeatureFolderEncryptSettings {
	recursive: boolean;
	/**
	 * Which files bulk encrypt touches: only Markdown (`md`) or every file
	 * type in the folder except already-encrypted ones (`all`).
	 */
	encryptScope: EncryptScope;
	/** Folders flagged as encrypted. Persisted with the plugin settings. */
	markedFolders: IMarkedFolder[];
}
