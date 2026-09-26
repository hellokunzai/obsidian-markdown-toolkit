import { TFile, normalizePath } from "obsidian";
import { t } from "../i18n";
import { MemoryCache } from "./MemoryCache";
import { Utils } from "./Utils";

export type PasswordAndHint = {
	password: string;
	hint: string;
}

export class SessionPasswordService{

	private static isActive = true;

	public static blankPasswordAndHint : PasswordAndHint = { password:'', hint:'' };

	private static cache = new MemoryCache<PasswordAndHint>();

	/**
	 * Callbacks invoked whenever the session cache is wiped — either because
	 * the remember-timer expired or because `clear()` was called manually.
	 * Other services (e.g. the folder-encrypt feature) register here so their
	 * own in-memory password store is wiped in lock-step, otherwise the
	 * "remember password time" setting would silently not apply to them.
	 */
	private static clearCallbacks: Array<() => void> = [];

	/** Register a callback fired on every session cache clear. De-duplicated. */
	public static registerClearCallback( callback: () => void ): void {
		if ( !SessionPasswordService.clearCallbacks.includes( callback ) ) {
			SessionPasswordService.clearCallbacks.push( callback );
		}
	}

	private static baseMinutesToExpire = 0;
	private static expiryTime : number | null = null;

	/**
	 * Wall-clock timer that proactively wipes the cache when the remember
	 * window elapses — without waiting for the next password access. Without
	 * this, expiry is "lazy" (only detected on the next `get*` call), so a
	 * folder would never auto-collapse at the exact moment its password timed
	 * out while the user simply kept it open.
	 */
	private static expiryTimer : number | null = null;

	public static setActive( isActive: boolean ) {
		SessionPasswordService.isActive = isActive;
		if (!SessionPasswordService.isActive){
			this.clear();
		} else {
			// re-arm the remember window now that password memory is enabled
			SessionPasswordService.updateExpiryTime();
		}
	}

	public static setAutoExpire( minutesToExpire:number | null ) : void{
		SessionPasswordService.baseMinutesToExpire = minutesToExpire ?? 0;
		SessionPasswordService.updateExpiryTime();
	}

	public static updateExpiryTime() : void {
		if (
			SessionPasswordService.baseMinutesToExpire == 0
			|| SessionPasswordService.baseMinutesToExpire == null
		){
			SessionPasswordService.expiryTime = null;
		} else {
			SessionPasswordService.expiryTime = Date.now() + SessionPasswordService.baseMinutesToExpire * 1000 * 60;
		}
		// (re)arm the proactive timer that actually wipes the cache at expiry
		SessionPasswordService.scheduleExpiryTimer();
	}

	/**
	 * (Re)arm the wall-clock timer that calls `clear()` when the remember
	 * window elapses. Called from `updateExpiryTime` on every access, so the
	 * window behaves as a sliding one (reset on each use). A pending timer is
	 * always cleared first to avoid duplicating the scheduled wipe.
	 */
	private static scheduleExpiryTimer(): void {
		SessionPasswordService.clearExpiryTimer();
		if (
			!SessionPasswordService.isActive
			|| SessionPasswordService.baseMinutesToExpire <= 0
		){
			return;
		}
		SessionPasswordService.expiryTimer = window.setTimeout(() => {
			SessionPasswordService.clear();
		}, SessionPasswordService.baseMinutesToExpire * 60 * 1000);
	}

	private static clearExpiryTimer(): void {
		if (SessionPasswordService.expiryTimer != null) {
			clearTimeout(SessionPasswordService.expiryTimer);
			SessionPasswordService.expiryTimer = null;
		}
	}

	/* ----------------------------------------------------------------- file */

	public static putByFile( pw: PasswordAndHint, file:TFile ): void {
		if (!SessionPasswordService.isActive){
			return;
		}
		const key = SessionPasswordService.getFileCacheKey( file );
		this.putByKey( key, pw );
		SessionPasswordService.updateExpiryTime();
	}

	public static async getByFile( file:TFile  ) : Promise<PasswordAndHint> {
		if (!SessionPasswordService.isActive){
			return SessionPasswordService.blankPasswordAndHint;
		}
		this.clearIfExpired();
		SessionPasswordService.updateExpiryTime();
		const direct = await this.getByKeyAsync(
			SessionPasswordService.getFileCacheKey( file ),
			SessionPasswordService.blankPasswordAndHint
		);
		if ( direct.password !== '' ){
			return direct;
		}
		// file-level miss → fall back to the covering folder's remembered
		// password, so notes inside a marked folder unlock without a prompt.
		return await this.getByKeyAsync(
			SessionPasswordService.getFolderOfFile( file.path ),
			SessionPasswordService.blankPasswordAndHint
		);
	}

	public static clearForFile( file: TFile ) : void {
		const key = SessionPasswordService.getFileCacheKey( file );
		this.cache.removeKey( key );
	}

	/* ------------------------------------------------------------- folder */

	/**
	 * Folder-level password (used by the folder-encrypt feature).
	 *
	 * The key is the folder path *itself* — NOT its parent. Callers pass the
	 * marked folder's path, so the cache key must equal that path verbatim
	 * (root collapses to `$root`). Files inside the folder look this up via
	 * `getFolderOfFile`, which resolves a file path to its containing folder
	 * and lands on the exact same key.
	 */
	public static putByFolder( pw: PasswordAndHint, folderPath: string ): void {
		if (!SessionPasswordService.isActive){
			return;
		}
		this.putByKey( SessionPasswordService.getFolderCacheKey( folderPath ), pw );
		SessionPasswordService.updateExpiryTime();
	}

	public static getByFolder( folderPath: string ) : PasswordAndHint {
		if (!SessionPasswordService.isActive){
			return SessionPasswordService.blankPasswordAndHint;
		}
		this.clearIfExpired();
		SessionPasswordService.updateExpiryTime();
		return this.getByKey(
			SessionPasswordService.getFolderCacheKey( folderPath ),
			SessionPasswordService.blankPasswordAndHint
		);
	}

	public static clearForFolder( folderPath: string ) : void {
		this.cache.removeKey( SessionPasswordService.getFolderCacheKey( folderPath ) );
	}

	/* --------------------------------------------------------------- path */

	/**
	 * Folder-level (no markerIndex) and inline-level (with markerIndex).
	 *
	 * - `markerIndex` given  → inline encryption: one remembered password per
	 *   marker, keyed by its position (0-based) in the file.
	 * - `markerIndex` omitted → folder-level: every note in the same folder
	 *   shares one remembered password.
	 *
	 * On a miss for an inline marker, the lookup falls back to the folder-
	 * level (parent-path) cache, so notes inside a marked folder decrypt
	 * with the folder password without prompting. A marker that has its own
	 * remembered password always wins over the folder fallback.
	 */
	public static putByPath( pw: PasswordAndHint, path:string, markerIndex?: number ): void {
		if (!SessionPasswordService.isActive){
			return;
		}
		const key = SessionPasswordService.getPathCacheKey( path, markerIndex );
		this.putByKey( key, pw );
		SessionPasswordService.updateExpiryTime();
	}

	public static getByPath( path: string, markerIndex?: number ) : PasswordAndHint {
		if (!SessionPasswordService.isActive){
			return SessionPasswordService.blankPasswordAndHint;
		}
		this.clearIfExpired();
		SessionPasswordService.updateExpiryTime();
		const direct = this.getByKey(
			SessionPasswordService.getPathCacheKey( path, markerIndex ),
			SessionPasswordService.blankPasswordAndHint
		);
		if ( direct.password !== '' ){
			return direct;
		}
		if ( markerIndex != null && markerIndex >= 0 ){
			// inline miss → cover the note with the folder password
			return this.getByKey(
				SessionPasswordService.getPathCacheKey( path ),
				SessionPasswordService.blankPasswordAndHint
			);
		}
		return direct;
	}

	public static async getByPathAsync( path: string, markerIndex?: number ) : Promise<PasswordAndHint> {
		if (!SessionPasswordService.isActive){
			return SessionPasswordService.blankPasswordAndHint;
		}
		this.clearIfExpired();
		SessionPasswordService.updateExpiryTime();
		const direct = await this.getByKeyAsync(
			SessionPasswordService.getPathCacheKey( path, markerIndex ),
			SessionPasswordService.blankPasswordAndHint
		);
		if ( direct.password !== '' ){
			return direct;
		}
		if ( markerIndex != null && markerIndex >= 0 ){
			return await this.getByKeyAsync(
				SessionPasswordService.getPathCacheKey( path ),
				SessionPasswordService.blankPasswordAndHint
			);
		}
		return direct;
	}

	public static clearForPath( path: string, markerIndex?: number ) : void {
		if ( markerIndex != null && markerIndex >= 0 ){
			this.cache.removeKey( SessionPasswordService.getPathCacheKey( path, markerIndex ) );
			return;
		}
		// folder-level key + every inline marker key belonging to this file
		this.cache.removeKey( SessionPasswordService.getFolderOfFile( path ) );
		this.cache.removeKeysWithPrefix( `${path}#` );
	}

	/* ------------------------------------------------------------ keying */

	/** Folder-level cache key: the folder path itself (root collapses to `$root`). */
	private static getFolderCacheKey( folderPath: string ) : string {
		const normalized = normalizePath( ( folderPath ?? '' ).trim() );
		if ( normalized === '' || normalized === '.' || normalized === '/' ) {
			return '$root';
		}
		return normalized;
	}

	/** Resolve a file path to its containing folder's cache key. */
	private static getFolderOfFile( filePath: string ) : string {
		const normalized = normalizePath( ( filePath ?? '' ).trim() );
		const idx = normalized.lastIndexOf( '/' );
		const parentPath = idx <= 0 ? '' : normalized.substring( 0, idx );
		return SessionPasswordService.getFolderCacheKey( parentPath );
	}

	private static getPathCacheKey( path : string, markerIndex?: number ) : string {
		if ( markerIndex != null && markerIndex >= 0 ){
			// inline encryption: one password per marker, ordered by position
			return `${path}#${markerIndex}`;
		}
		// no marker → folder-level: resolve the path's containing folder key.
		// When `path` is a file, this is its folder; when `path` is the folder
		// itself it resolves to the same key as `getFolderCacheKey(path)`.
		return SessionPasswordService.getFolderOfFile( path );
	}

	private static getFileCacheKey( file : TFile ) : string {
		// whole-note encryption: one password per file
		return Utils.getFilePathExcludingExtension( file );
	}

	/* ------------------------------------------------------------- infra */

	private static clearIfExpired() : void{
		if ( SessionPasswordService.expiryTime == null ){
			return;
		}
		if ( Date.now() < SessionPasswordService.expiryTime ){
			return;
		}
		this.clear();
	}

	public static clear(): number {
		const count = this.cache.getKeys().length;
		this.cache.clear();
		// reset the remember window and cancel the pending timer so the cache
		// is not re-armed (or re-cleared) until the next password access.
		SessionPasswordService.expiryTime = null;
		SessionPasswordService.clearExpiryTimer();
		// the folder-encrypt feature keeps its own in-memory password map
		// that must be wiped together with the session cache, otherwise the
		// "remember password time" setting has no effect on encrypted folders.
		for ( const callback of SessionPasswordService.clearCallbacks ) {
			callback();
		}
		return count;
	}

	private static putByKey( key: string, pw: PasswordAndHint ) : void {
		this.cache.put( key, pw );
	}

	private static getByKey( key: string, defaultValue: PasswordAndHint ): PasswordAndHint {
		return this.cache.get( key, defaultValue );
	}

	public static async getByKeyAsync( key: string, defaultValue: PasswordAndHint ): Promise<PasswordAndHint> {
		return this.cache.get( key, defaultValue );
	}
}
