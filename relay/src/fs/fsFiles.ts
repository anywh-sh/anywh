import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

// Backs the work dir file panel — list/read/raw for a session's
// cwd. Deliberately separate from `fsBrowse.ts`, which keeps serving the
// folder picker (directories only, no root confinement: picking a new
// working directory needs to be able to navigate anywhere).

export type FilesError = "not_found" | "permission_denied" | "invalid_path" | "outside_root";

function errorFromErrno(error: unknown): FilesError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "not_found";
}

type ResolveResult = { ok: true; root: string; path: string } | { ok: false; error: FilesError };

/**
 * Confirms `rawPath` (or, if omitted, the root itself) resolves inside
 * `rawRoot` — `path.resolve` + `realpathSync` of both sides, so a `../` or a
 * symlink that escapes the root is rejected the same way. This is **not** a
 * security boundary — anyone who can reach the relay already has full shell
 * access on this machine via the embedded terminal or `--dangerously-skip-permissions`
 * itself (see README "Security model"), root confinement or not. It's a
 * contract: it guarantees the root really is the session's cwd, and that a
 * UI bug can't end up requesting something like `/etc`.
 */
export function resolveWithinRoot(rawRoot: string, rawPath: string | null): ResolveResult {
  let root: string;
  try {
    root = realpathSync(rawRoot);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }

  if (rawPath === null) return { ok: true, root, path: root };
  if (!isAbsolute(rawPath)) return { ok: false, error: "invalid_path" };

  let resolved: string;
  try {
    resolved = realpathSync(resolve(rawPath));
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, error: "outside_root" };
  }
  return { ok: true, root, path: resolved };
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  mtimeMs: number;
}

export type ListResult = { ok: true; root: string; path: string; entries: FileEntry[] } | { ok: false; error: FilesError };

/** Dotfiles and `node_modules` are exactly the noise nobody wants in the
 * tree by default — `showHidden` (the `all=1` query
 * param) turns the filter off for the rare "I need my `.env`" case. */
function isHidden(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** Lazy, one folder at a time — never recursive: recursive listing
 * doesn't scale once `node_modules` is involved. */
export function listFiles(rawRoot: string, rawPath: string | null, showHidden: boolean): ListResult {
  const resolved = resolveWithinRoot(rawRoot, rawPath);
  if (!resolved.ok) return resolved;

  let dirents;
  try {
    dirents = readdirSync(resolved.path, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (!showHidden && isHidden(dirent.name)) continue;
    const fullPath = join(resolved.path, dirent.name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // disappeared mid-read or broken symlink — ignore silently, same as fsBrowse.
    }
    entries.push({
      name: dirent.name,
      path: fullPath,
      kind: stat.isDirectory() ? "dir" : "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return { ok: true, root: resolved.root, path: resolved.path, entries };
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

// Above this, a text file is read only up to the cap and flagged
// `truncated` — the viewer shows a warning strip instead of loading
// something the webview can't reasonably render anyway.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// Only the first chunk needs sniffing to tell text from binary.
const BINARY_SNIFF_BYTES = 8 * 1024;

/** A byte `0x00`, or a high ratio of non-printable control bytes, marks a
 * file as binary — same heuristic `file`/git use. Tabs/newlines/CR don't
 * count against it, and anything `>= 0x80` is treated as text (UTF-8
 * multibyte sequences, not a control byte). */
function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;
  let controlCount = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 0x20) continue;
    controlCount++;
  }
  return controlCount / buffer.length > 0.3;
}

export type ReadResult =
  | { ok: true; kind: "text"; path: string; content: string; size: number; mtimeMs: number; truncated: boolean }
  | { ok: true; kind: "image"; path: string; size: number; mtimeMs: number; mime: string }
  | { ok: true; kind: "binary"; path: string; size: number; mtimeMs: number }
  | { ok: false; error: FilesError };

export function readFileForViewer(rawRoot: string, rawPath: string): ReadResult {
  const resolved = resolveWithinRoot(rawRoot, rawPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = statSync(resolved.path);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };

  // Image detection is by extension only — never opens the file just to
  // decide, `/files/raw` (a separate request) is what actually reads bytes.
  const mime = IMAGE_MIME_BY_EXT[extname(resolved.path).toLowerCase()];
  if (mime) {
    return { ok: true, kind: "image", path: resolved.path, size: stat.size, mtimeMs: stat.mtimeMs, mime };
  }

  const fd = openSync(resolved.path, "r");
  try {
    const sniffSize = Math.min(BINARY_SNIFF_BYTES, stat.size);
    const sniffBuffer = Buffer.alloc(sniffSize);
    readSync(fd, sniffBuffer, 0, sniffSize, 0);
    if (looksBinary(sniffBuffer)) {
      return { ok: true, kind: "binary", path: resolved.path, size: stat.size, mtimeMs: stat.mtimeMs };
    }

    const truncated = stat.size > MAX_TEXT_BYTES;
    const readSize = truncated ? MAX_TEXT_BYTES : stat.size;
    const contentBuffer = Buffer.alloc(readSize);
    readSync(fd, contentBuffer, 0, readSize, 0);
    return { ok: true, kind: "text", path: resolved.path, content: contentBuffer.toString("utf-8"), size: stat.size, mtimeMs: stat.mtimeMs, truncated };
  } finally {
    closeSync(fd);
  }
}

export type DeleteResult = { ok: true } | { ok: false; error: FilesError };

/** File-only, same as the rest of this module's write surface below — the
 * context menu that drives this (the file tree) never shows these actions
 * for a directory row. */
export function deleteFile(rawRoot: string, rawPath: string): DeleteResult {
  const resolved = resolveWithinRoot(rawRoot, rawPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = statSync(resolved.path);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };

  try {
    unlinkSync(resolved.path);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  return { ok: true };
}

export type FilesWriteError = FilesError | "invalid_name" | "already_exists";
export type RenameResult = { ok: true; path: string } | { ok: false; error: FilesWriteError };

/** Renames within the same directory only — `newName` is validated to be a
 * bare filename (no separator), so this can never move a file to a
 * different directory or escape the root the way an arbitrary destination
 * path could. */
export function renameFile(rawRoot: string, rawPath: string, newName: string): RenameResult {
  const resolved = resolveWithinRoot(rawRoot, rawPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = statSync(resolved.path);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };

  const trimmed = newName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(sep) || trimmed === "." || trimmed === "..") {
    return { ok: false, error: "invalid_name" };
  }

  const target = join(dirname(resolved.path), trimmed);
  if (existsSync(target)) return { ok: false, error: "already_exists" };

  try {
    renameSync(resolved.path, target);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  return { ok: true, path: target };
}

export type CreateResult = { ok: true; path: string } | { ok: false; error: FilesWriteError };

/** Creates a file directly under `rawDir` (or the root itself when `rawDir`
 * is `null` — the file tree's panel-level "new file" context menu always
 * creates at the root today). `name` is validated the same way
 * `renameFile`'s `newName` is, and creation fails closed if something
 * already exists at the target path rather than silently truncating it.
 * `content` defaults to empty (the "new file" context menu's case) — the
 * file panel's drag-and-drop upload (`/files/upload`, server.ts) is the
 * other caller, passing the dropped file's bytes instead. */
export function createFile(rawRoot: string, rawDir: string | null, name: string, content: Buffer | string = ""): CreateResult {
  const resolvedDir = resolveWithinRoot(rawRoot, rawDir);
  if (!resolvedDir.ok) return resolvedDir;

  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes(sep) || trimmed === "." || trimmed === "..") {
    return { ok: false, error: "invalid_name" };
  }

  const target = join(resolvedDir.path, trimmed);
  if (existsSync(target)) return { ok: false, error: "already_exists" };

  try {
    writeFileSync(target, content);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  return { ok: true, path: target };
}

/**
 * Breadth-first search under `root` (already resolved by
 * `resolveWithinRoot`) for an entry (file, or directory when `isDirectory`)
 * whose path relative to `root` ends with exactly `segments`, in order —
 * `["voice-jarvis"]` matches any `voice-jarvis` directly under `root`,
 * `["prototypes","voice-jarvis"]` only matches one sitting inside a
 * `prototypes` folder, wherever that pair occurs under `root`. Generalizes
 * a bare-filename search (`segments.length === 1`) to a full relative-path
 * *suffix* match, for when the session's root is some ancestor above where
 * the chat-mentioned path actually starts — e.g. root is a multi-repo
 * workspace folder and the model wrote a path relative to one repo inside
 * it (a real case: root `~/anywh`, mention `relay/scripts/anywh-bg`, real
 * location `~/anywh/anywh/relay/scripts/anywh-bg`). Same hidden/
 * `node_modules` skip as `listFiles`. BFS (not depth-first) so the
 * *shallowest* match wins when the same suffix occurs at more than one
 * depth. `maxVisited` bounds the total directories scanned — this is a
 * one-shot, click-triggered search, not the recursive tree *rendering*
 * `listFiles`'s own doc comment warns against; a repo any real
 * project's size stays far under the cap, and a huge non-hidden tree just
 * gets a bounded, not unbounded, scan.
 */
function findBySuffix(root: string, segments: string[], isDirectory: boolean, maxVisited = 20_000): string | null {
  const lastName = segments[segments.length - 1];
  const queue: string[] = [root];
  let visited = 0;

  while (queue.length > 0 && visited < maxVisited) {
    const dir = queue.shift()!;
    visited++;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isHidden(dirent.name) || dirent.name !== lastName) continue;
      if (dirent.isDirectory() !== isDirectory) continue;
      const candidate = join(dir, dirent.name);
      if (matchesSuffix(root, candidate, segments)) return candidate;
    }
    for (const dirent of dirents) {
      if (!isHidden(dirent.name) && dirent.isDirectory()) queue.push(join(dir, dirent.name));
    }
  }
  return null;
}

/** Whether `candidate`'s path relative to `root` ends with `segments`, in
 * order — the trailing-segment check `findBySuffix` uses once it's already
 * found a name match, to reject e.g. a `voice-jarvis` that isn't actually
 * inside a `prototypes` folder when the mention was `prototypes/voice-jarvis`. */
function matchesSuffix(root: string, candidate: string, segments: string[]): boolean {
  const relative = candidate.slice(root.length).split(sep).filter(Boolean);
  if (relative.length < segments.length) return false;
  const tail = relative.slice(relative.length - segments.length);
  return tail.every((part, i) => part === segments[i]);
}

/** Ancestor directories of `absolute` (itself excluded), root-to-leaf,
 * confined to `root` — `absolute` is assumed to already be a real path
 * under `root` (only called with a `findBySuffix` hit or a directory
 * confirmed by `resolveChatPath`'s own walk), so every segment is known to
 * exist without re-checking the filesystem. */
function ancestorsOf(root: string, absolute: string): string[] {
  const relative = absolute.slice(root.length).split(sep).filter(Boolean);
  const dirs: string[] = [];
  let current = root;
  for (const segment of relative.slice(0, -1)) {
    current = join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

export interface ChatPathResolution {
  /** Absolute path to try opening in the viewer — `null` when nothing
   * plausible exists (a bare filename found nowhere under the root) or
   * `isDirectory` is true (nothing to open in a file viewer). Not itself
   * guaranteed to be a real, readable file: the caller's follow-up
   * `/files/read` still runs the full `resolveWithinRoot` check before ever
   * serving bytes — this function only ever returns path *strings*, so a
   * best-effort guess here carries no security weight of its own. */
  target: string | null;
  isDirectory: boolean;
  /** Ancestor directories confirmed to exist under the root, root-to-leaf —
   * a caller expands all of these in the file tree regardless of whether
   * `target` panned out, so a chat mention that's slightly off (wrong
   * filename, wrong last segment) still lands the user somewhere browsable
   * instead of just failing silently. */
  existingDirs: string[];
}

/** Ancestor chain of `absolute` walked from `root` down, stopping at the
 * first segment that doesn't exist as a directory — the confirmed prefix is
 * what a caller expands in the tree even when the full path doesn't
 * resolve. `isDirectory` decides whether the last segment is itself a
 * directory to include (`existingDirs`) or a filename to leave out of the
 * walk (only its parent chain matters). */
function walkAncestors(root: string, absolute: string, isDirectory: boolean): ChatPathResolution {
  const relativeSegments = absolute === root ? [] : absolute.slice(root.length).split(sep).filter(Boolean);
  const dirSegments = isDirectory ? relativeSegments : relativeSegments.slice(0, -1);

  const existingDirs: string[] = [];
  let current = root;
  for (const segment of dirSegments) {
    const next = join(current, segment);
    let stat;
    try {
      stat = statSync(next);
    } catch {
      break;
    }
    if (!stat.isDirectory()) break;
    existingDirs.push(next);
    current = next;
  }

  return { target: isDirectory ? null : absolute, isDirectory, existingDirs };
}

/** `findBySuffix` hit → the resolution shape `resolveChatPath` returns:
 * ancestors (self included when it's a directory, so the tree reveals its
 * own contents too) plus the target itself. */
function resolutionFromMatch(root: string, found: string, isDirectory: boolean): ChatPathResolution {
  const dirs = ancestorsOf(root, found);
  return { target: isDirectory ? null : found, isDirectory, existingDirs: isDirectory ? [...dirs, found] : dirs };
}

/**
 * Resolves a path as written in chat text (relative to the session's cwd,
 * already absolute, a bare filename, or a directory — trailing `/`) into
 * something the file panel can act on.
 *
 * An already-absolute path is trusted exactly (confined to the root, its
 * ancestor chain walked from there) — the model gave a full path, no need
 * to guess. A relative path with no `/` at all (a bare filename, `App.tsx`)
 * always searches (`findBySuffix`): most chat mentions of a single file
 * don't include its directory, and joining it straight onto the root is
 * almost never right once it lives more than one level deep. A relative
 * path *with* a `/` is joined against the root first — the common case,
 * where the session's root really is what the model had in mind — but
 * falls back to the same suffix search when even the *first* segment
 * doesn't exist directly under the root: a strong signal the root is some
 * ancestor above where the mention actually starts (a multi-repo workspace
 * folder, the mention relative to one repo inside it), not that the model
 * made something up. Either way the search still requires every given
 * segment to match, in order, just not to start exactly at the root.
 */
export function resolveChatPath(rawRoot: string, rawPath: string): ChatPathResolution {
  const rootResolved = resolveWithinRoot(rawRoot, null);
  if (!rootResolved.ok) return { target: null, isDirectory: false, existingDirs: [] };
  const root = rootResolved.root;

  const isDirectory = rawPath.endsWith("/");
  const trimmed = isDirectory ? rawPath.replace(/\/+$/, "") : rawPath;
  if (!trimmed) return { target: null, isDirectory: false, existingDirs: [] };

  if (isAbsolute(trimmed)) {
    const normalizedRoot = root.endsWith(sep) ? root : root + sep;
    if (trimmed !== root && !trimmed.startsWith(normalizedRoot)) {
      return { target: null, isDirectory: false, existingDirs: [] };
    }
    return walkAncestors(root, trimmed, isDirectory);
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return { target: null, isDirectory: false, existingDirs: [] };

  if (segments.length === 1) {
    const found = findBySuffix(root, segments, isDirectory);
    return found ? resolutionFromMatch(root, found, isDirectory) : { target: null, isDirectory: false, existingDirs: [] };
  }

  if (existsSync(join(root, segments[0]))) {
    return walkAncestors(root, join(root, ...segments), isDirectory);
  }

  const found = findBySuffix(root, segments, isDirectory);
  if (found) return resolutionFromMatch(root, found, isDirectory);
  return { target: isDirectory ? null : join(root, ...segments), isDirectory, existingDirs: [] };
}

export type RawResult = { ok: true; path: string; mime: string } | { ok: false; error: FilesError };

/** Resolution/validation only — `server.ts` owns the actual byte streaming
 * (`createReadStream`), same split of responsibility as the rest of this
 * module keeping HTTP out of it. */
export function resolveRawFile(rawRoot: string, rawPath: string): RawResult {
  const resolved = resolveWithinRoot(rawRoot, rawPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = statSync(resolved.path);
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };

  const mime = IMAGE_MIME_BY_EXT[extname(resolved.path).toLowerCase()] ?? "application/octet-stream";
  return { ok: true, path: resolved.path, mime };
}
