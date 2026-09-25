import {
  Vault,
  TFolder,
  moment,
  normalizePath,
  type App,
  type TAbstractFile,
  type TFile,
} from "obsidian";

/**
 * Shared path / token helpers for every attachment feature.
 *
 * Factored out of the earlier paste/drop handler so the cleanup and rename-sync
 * features resolve the same folder template and token set without three copies
 * drifting apart. Everything here is a pure function of its arguments except
 * `cleanEmptyFolders`, which touches the vault.
 */

/**
 * Extensions we treat as "attachments" for cleanup and relocation.
 *
 * Kept deliberately close to the embed set but widened to the document types a
 * note commonly links (office docs, archives) so a stray download gets cleaned
 * up too. This is a allow-list, so a `.css` / `.json` / plugin file is never
 * mistaken for an attachment.
 */
const ATTACHMENT_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "tiff", "ico",
  "mp3", "webm", "ogg", "wav", "m4a", "3gp", "flac", "aac",
  "mp4", "mov", "ogv", "mkv", "avi", "webm",
  "pdf",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "7z", "tar", "gz", "rar",
  "txt", "csv",
]);

export interface NoteContext {
  path: string;
  basename: string;
  folder: string;
}

export function noteContext(notePath: string): NoteContext {
  const slash = notePath.lastIndexOf("/");
  const folder = slash >= 0 ? notePath.slice(0, slash) : "";
  const basename = notePath.slice(slash + 1).replace(/\.[^.]+$/, "");
  return { path: notePath, basename, folder };
}

export function isAttachment(file: TFile): boolean {
  return ATTACHMENT_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * Drops the extension from a file name, keeping the name as-is when there is
 * nothing that qualifies as one.
 *
 * Same three guards Obsidian applies when it derives an extension (`""` for a
 * dot-file like `.env`, for a trailing dot, and for a name with no dot at all),
 * so a dot-file does not turn into an empty base name here.
 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot);
}

export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, raw: string) => {
    const key = raw.trim();
    if (key.startsWith("date:")) {
      const format = key.slice("date:".length).trim();
      return (moment as unknown as () => { format: (f: string) => string })()
        .format(format);
    }
    return key in vars ? vars[key] : "";
  });
}

/**
 * The "special characters" preference: which characters are unwelcome in a
 * generated folder or file name, and what to put in their place.
 *
 * `replacement` of `""` deletes them instead of substituting anything.
 */
export interface SpecialCharRules {
  chars: string;
  replacement: string;
}

/** Empty rules (keep everything) — handy as a fallback for callers without settings. */
export const NO_SPECIAL_CHAR_RULES: SpecialCharRules = { chars: "", replacement: "" };

const CHARS_REGEXP_CACHE = new Map<string, RegExp>();

function specialCharsRegExp(chars: string): RegExp {
  const cached = CHARS_REGEXP_CACHE.get(chars);
  if (cached) return cached;
  // Build a character class out of the user's literal list. Escaping inside a
  // class only needs the four characters that are special there.
  const body = chars.replace(/[\\\]^/-]/g, "\\$&");
  const regexp = new RegExp(`[${body}]+`, "gu");
  CHARS_REGEXP_CACHE.set(chars, regexp);
  return regexp;
}

/**
 * Swaps every run of the user's special characters for the replacement string.
 *
 * A replacement is used as a literal (never as a `$1` backreference), and an
 * empty character list is a no-op — both mirror the reference plugin so the
 * setting behaves the way users expect.
 */
export function sanitizeName(value: string, rules: SpecialCharRules): string {
  if (!rules.chars) return value;
  return value.replace(specialCharsRegExp(rules.chars), () => rules.replacement);
}

/** Obsidian's own de-duplication separator, and our fallback for an empty one. */
const FALLBACK_SEPARATOR = " ";

/**
 * The separator used when a generated name collides with an existing file.
 *
 * Whatever the user typed goes through the same special-character rules as the
 * rest of the name — the separator ends up in a file name too. An empty one (or
 * one the rules erased) would fuse the counter into the name (`photo1.png`), so
 * it falls back to the space Obsidian itself uses.
 */
export function resolveDuplicateSeparator(
  value: string,
  rules: SpecialCharRules = NO_SPECIAL_CHAR_RULES
): string {
  const cleaned = sanitizeName(value, rules);
  return cleaned === "" ? FALLBACK_SEPARATOR : cleaned;
}

/** How many `name-1`, `name-2` … candidates to try before giving up. */
const MAX_DUPLICATE_TRIES = 1000;

/**
 * First free path for `basePath` + `extension`, appending `separator` and a
 * counter (`photo-1.png`, `photo-2.png`, …) when the name is taken.
 *
 * Mirrors Obsidian's own `getAvailablePath` — which hard-codes a space as the
 * separator — but takes the user's, and keeps its two other properties: the
 * argument is a path *without* extension, and matching is case-insensitive
 * (decompiled from `obsidian.asar`: `getAbstractFileByPathInsensitive`).
 */
export function uniqueAttachmentPath(
  app: App,
  basePath: string,
  extension: string,
  separator: string
): string {
  const withExtension = (path: string): string =>
    extension === "" ? path : `${path}.${extension}`;
  const taken = new Set(
    app.vault.getAllLoadedFiles().map((file) => file.path.toLowerCase())
  );

  if (!taken.has(withExtension(basePath).toLowerCase())) {
    return withExtension(basePath);
  }

  // The counter belongs to the file name, so only that last segment changes.
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash + 1) : "";
  const base = basePath.slice(slash + 1);
  for (let index = 1; index <= MAX_DUPLICATE_TRIES; index++) {
    const candidate = withExtension(`${dir}${base}${separator}${index}`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological vault; hand back the un-suffixed path and let the write report.
  return withExtension(basePath);
}

/**
 * Resolves the attachment folder template against a note.
 *
 * Returns `null` when the template is empty (the user wants Obsidian's own
 * default location), otherwise a normalized vault-relative path. A leading
 * `./` or `../` anchors the result to the note's own folder; anything else is
 * relative to the vault root.
 *
 * Special-character rules are applied per path segment, so a `/` in the user's
 * character list cleans the names without eating the separators. The note's own
 * folder is never sanitized: it already exists, and rewriting it would send the
 * attachment to a folder that isn't the note's.
 */
export function resolveFolderTemplate(
  template: string,
  note: NoteContext,
  rules: SpecialCharRules = NO_SPECIAL_CHAR_RULES
): string | null {
  const tpl = template.trim();
  if (tpl === "") return null;

  const expanded = applyTemplate(tpl, {
    noteFileName: note.basename,
    folderPath: note.folder,
    originalFileName: "",
  });
  const resolved = cleanSegments(expanded.replace(/^\.\//, ""), rules);
  // A template that sanitized down to nothing has no target folder left, so
  // hand the decision back to Obsidian's own attachment location.
  if (resolved === "") return null;

  if (tpl.startsWith("./") || tpl.startsWith("../")) {
    const anchored = normalizePath(`${note.folder}/${resolved}`);
    return anchored === "" ? null : anchored;
  }
  return resolved;
}

/** Sanitizes each segment of a relative path and drops the ones that came out empty. */
function cleanSegments(path: string, rules: SpecialCharRules): string {
  return normalizePath(
    path
      .split("/")
      .map((segment) => sanitizeName(segment, rules))
      .filter((segment) => segment !== "")
      .join("/")
  );
}

/**
 * What to do when a note's attachment folder has become empty (after a
 * rename-sync move, a relocation, or orphan cleanup).
 *
 * - `keep`: leave the empty folder in place.
 * - `delete`: trash the folder itself, but never touch its parents.
 * - `delete-and-parents`: also sweep parent folders that this emptied out.
 */
export type EmptyFolderHandling = "keep" | "delete" | "delete-and-parents";

/**
 * Applies the "empty attachment folder handling" preference to `rootPath`.
 *
 * Empty subfolders inside the root are swept first (deepest first), so a folder
 * holding only empty children also counts as empty. Only ever deletes truly
 * empty folders, so a sibling non-attachment file is left untouched.
 */
export async function handleEmptyFolder(
  app: App,
  rootPath: string,
  mode: EmptyFolderHandling
): Promise<void> {
  if (mode === "keep") return;

  const root = app.vault.getFolderByPath(rootPath);
  if (!root) return;

  const folders: TFolder[] = [];
  Vault.recurseChildren(root, (child: TAbstractFile) => {
    if (child instanceof TFolder) folders.push(child);
  });
  // Deepest path first → children before parents, root last.
  folders.sort((a, b) => b.path.length - a.path.length);

  for (const folder of folders) {
    if (folder.children.length === 0) {
      await trashQuietly(app, folder);
    }
  }

  if (mode !== "delete-and-parents") return;
  if (app.vault.getFolderByPath(rootPath)) return; // root still has content

  // Walk up and clear out parents this removal left behind. A parent with a
  // slash-less path is the vault root itself and is never deleted.
  let path = rootPath;
  for (;;) {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) break;
    path = path.slice(0, slash);
    const parent = app.vault.getFolderByPath(path);
    if (!parent || parent.children.length > 0) break;
    await trashQuietly(app, parent);
  }
}

async function trashQuietly(app: App, folder: TFolder): Promise<void> {
  try {
    await app.vault.trash(folder, true);
  } catch {
    // Folder may already be gone, or trash failed; either way, move on.
  }
}

/**
 * Whether `file` is still linked from any note. `excludePaths` lets a caller
 * mask sources whose backlinks are in flight — notably a note that was just
 * deleted and whose cache entry may not be gone yet.
 */
export function isReferencedBy(
  app: App,
  file: TFile,
  excludePaths?: ReadonlySet<string>
): boolean {
  const backlinks = (app.metadataCache as unknown as {
    getBacklinksForFile(file: TFile): {
      keys?(): Iterable<string>;
      data?: Map<string, unknown>;
    } | null;
  }).getBacklinksForFile(file);
  if (!backlinks) return false;
  const keys =
    typeof backlinks.keys === "function"
      ? Array.from(backlinks.keys() as Iterable<string>)
      : backlinks.data
        ? Array.from(backlinks.data.keys())
        : [];
  if (keys.length === 0) return false;
  if (!excludePaths || excludePaths.size === 0) return true;
  return keys.some((source) => !excludePaths.has(source));
}
