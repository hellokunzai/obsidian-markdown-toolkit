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

export interface IFeatureFolderEncryptSettings {
	recursive: boolean;
	/** Folders flagged as encrypted. Persisted with the plugin settings. */
	markedFolders: IMarkedFolder[];
}
