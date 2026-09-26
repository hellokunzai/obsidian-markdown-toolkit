import { normalizePath } from "obsidian";
import { IMarkedFolder } from "./IFeatureFolderEncryptSettings";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService";

/**
 * Holds the list of folders flagged as "encrypted".
 *
 * The list itself lives in the plugin settings (persisted); passwords live in
 * an in-memory map only, so they never touch the disk. When a password is not
 * in memory we fall back to the plugin's session password service, and only
 * then ask the user.
 */
export class FolderMarkService {

	/** Reference to the array stored in the plugin settings — mutated in place. */
	private static marks: IMarkedFolder[] = [];

	private static readonly passwords = new Map<string, PasswordAndHint>();

	static readonly rootPath = "/";

	/** Bind the service to the settings array and normalise every stored path. */
	static bind(marks: IMarkedFolder[] | undefined | null): IMarkedFolder[] {
		const list = Array.isArray(marks) ? marks : [];
		for (const mark of list) {
			mark.path = FolderMarkService.normalizeFolderPath(mark.path);
			mark.hint = mark.hint ?? "";
			mark.recursive = mark.recursive ?? true;
		}
		FolderMarkService.marks = list;
		// When the session remember-timer expires (or the cache is cleared),
		// wipe the folder passwords too so the folder auto-lock re-engages and
		// the "remember password time" setting applies to encrypted folders.
		SessionPasswordService.registerClearCallback(FolderMarkService.clearPasswordsForSession);
		return list;
	}

	/** Clears only the in-memory folder passwords — used on session clear. */
	private static readonly clearPasswordsForSession = (): void => {
		FolderMarkService.passwords.clear();
	};

	static getMarks(): IMarkedFolder[] {
		return FolderMarkService.marks;
	}

	static normalizeFolderPath(path: string): string {
		const normalized = normalizePath((path ?? "").trim());
		if (normalized === "" || normalized === ".") {
			return FolderMarkService.rootPath;
		}
		return normalized;
	}

	/** Parent folder path of a file path. Files in the vault root return "/". */
	static getParentPath(filePath: string): string {
		const normalized = normalizePath(filePath ?? "");
		const idx = normalized.lastIndexOf("/");
		if (idx <= 0) {
			return FolderMarkService.rootPath;
		}
		return normalized.substring(0, idx);
	}

	static isMarked(folderPath: string): boolean {
		return FolderMarkService.getMark(folderPath) != null;
	}

	/** Find a mark whose path is exactly this folder. */
	static getMark(folderPath: string): IMarkedFolder | null {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		return FolderMarkService.marks.find(m => m.path === target) ?? null;
	}

	/**
	 * Find the mark covering a file's parent folder. When several marks match
	 * (e.g. a folder inside a recursive marked folder) the most specific one
	 * wins, so the closest folder's password is used.
	 */
	static findMarkForParentPath(parentPath: string): IMarkedFolder | null {
		const target = FolderMarkService.normalizeFolderPath(parentPath);
		let best: IMarkedFolder | null = null;

		for (const mark of FolderMarkService.marks) {
			let covered = false;

			if (mark.path === FolderMarkService.rootPath) {
				covered = mark.recursive;
			} else if (mark.recursive) {
				covered = target === mark.path || target.startsWith(mark.path + "/");
			} else {
				covered = target === mark.path;
			}

			if (covered && (best == null || mark.path.length > best.path.length)) {
				best = mark;
			}
		}

		return best;
	}

	static addMark(mark: IMarkedFolder): void {
		const path = FolderMarkService.normalizeFolderPath(mark.path);
		const existing = FolderMarkService.getMark(path);
		if (existing != null) {
			existing.hint = mark.hint ?? "";
			existing.recursive = mark.recursive ?? true;
			return;
		}
		FolderMarkService.marks.push({
			path,
			hint: mark.hint ?? "",
			recursive: mark.recursive ?? true
		});
	}

	static removeMark(folderPath: string): boolean {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		const before = FolderMarkService.marks.length;
		const remaining = FolderMarkService.marks.filter(m => m.path !== target);
		if (remaining.length === before) {
			return false;
		}
		FolderMarkService.marks.splice(0, FolderMarkService.marks.length, ...remaining);
		FolderMarkService.passwords.delete(target);
		SessionPasswordService.clearForFolder(target);
		return true;
	}

	/**
	 * Keep marks in sync when a folder is renamed or moved:
	 * the mark itself is renamed, and marks underneath follow their parent.
	 */
	static renameFolder(oldPath: string, newPath: string): boolean {
		const oldNorm = FolderMarkService.normalizeFolderPath(oldPath);
		const newNorm = FolderMarkService.normalizeFolderPath(newPath);
		if (oldNorm === newNorm) {
			return false;
		}

		let changed = false;
		const prefix = oldNorm === FolderMarkService.rootPath ? "/" : oldNorm + "/";

		for (const mark of FolderMarkService.marks) {
			if (mark.path === oldNorm) {
				mark.path = newNorm;
				changed = true;
			} else if (oldNorm !== FolderMarkService.rootPath && mark.path.startsWith(prefix)) {
				mark.path = newNorm + mark.path.substring(oldNorm.length);
				changed = true;
			}
		}

		if (changed) {
			FolderMarkService.movePassword(oldNorm, newNorm);
			SessionPasswordService.clearForFolder(oldNorm);
		}
		return changed;
	}

	/** Remove the mark of a deleted folder, plus any marks it contained. */
	static removeFolder(folderPath: string): boolean {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		const prefix = target === FolderMarkService.rootPath ? "/" : target + "/";
		const before = FolderMarkService.marks.length;
		const remaining = FolderMarkService.marks.filter(m => {
			if (m.path === target) {
				return false;
			}
			return !(target !== FolderMarkService.rootPath && m.path.startsWith(prefix));
		});
		if (remaining.length === before) {
			return false;
		}
		FolderMarkService.marks.splice(0, FolderMarkService.marks.length, ...remaining);
		FolderMarkService.passwords.delete(target);
		SessionPasswordService.clearForFolder(target);
		return true;
	}

	/* ---------------- passwords (in memory only) ---------------- */

	static putPassword(folderPath: string, passwordAndHint: PasswordAndHint): void {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		FolderMarkService.passwords.set(target, passwordAndHint);
		// also hand it to the plugin's session cache so other flows can reuse it.
		// NOTE: keyed by the folder path itself (not its parent).
		SessionPasswordService.putByFolder(passwordAndHint, target);
	}

	static getPassword(folderPath: string): PasswordAndHint {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		// Touch the session cache first: this slides the remember-timer forward
		// on every access AND, when the timer has expired, wipes the folder
		// password via the registered clear callback. Only after that do we
		// read our own (now possibly cleared) in-memory store.
		SessionPasswordService.getByFolder(target);
		const inMemory = FolderMarkService.passwords.get(target);
		if (inMemory != null && inMemory.password !== "") {
			return inMemory;
		}
		// fall back to the plugin's session password cache, keyed by folder path
		return SessionPasswordService.getByFolder(target);
	}

	static hasPassword(folderPath: string): boolean {
		return FolderMarkService.getPassword(folderPath).password !== "";
	}

	/**
	 * Like `hasPassword`, but reads only the in-memory map — it does NOT touch
	 * the session password service. Used when collapsing folders on session
	 * clear, where reaching into the session service would re-arm the remember
	 * timer and defeat the whole point of expiring.
	 */
	static hasPasswordInMemory(folderPath: string): boolean {
		const target = FolderMarkService.normalizeFolderPath(folderPath);
		const inMemory = FolderMarkService.passwords.get(target);
		return inMemory != null && inMemory.password !== "";
	}

	static clearPasswords(): void {
		FolderMarkService.passwords.clear();
		SessionPasswordService.clear();
	}

	private static movePassword(oldPath: string, newPath: string): void {
		const pw = FolderMarkService.passwords.get(oldPath);
		if (pw == null) {
			return;
		}
		FolderMarkService.passwords.delete(oldPath);
		FolderMarkService.passwords.set(newPath, pw);
	}
}
