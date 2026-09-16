import { statSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Supports the folder-picker modal (see the "working directory" plan docs) —
// lists only subdirectories, never files. Synchronous and pure on purpose:
// no async I/O nor dependency on the HTTP request, so it can be called both
// from the `GET /fs/list` endpoint and from the validation in
// `SharedSession.setCwd` without duplicating the error logic.

export type FsError = "not_found" | "permission_denied" | "not_a_directory" | "invalid_path";

export interface FsEntry {
  name: string;
  path: string;
}

type CheckResult = { ok: true; path: string } | { ok: false; error: FsError };

function errorFromErrno(error: unknown): FsError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "not_found";
}

/** Confirms that `rawPath` exists and is a directory, returning the
 * canonical form (`path.resolve`) — this is what the client uses as
 * `browsePath` after each navigation, so the breadcrumb always reflects what
 * the server confirmed (not what was typed/clicked). */
export function checkDirectory(rawPath: string): CheckResult {
  if (!isAbsolute(rawPath)) return { ok: false, error: "invalid_path" };
  const resolved = resolve(rawPath);
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, error: "not_a_directory" };
    return { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }
}

type ListResult = { ok: true; path: string; entries: FsEntry[] } | { ok: false; error: FsError };

/** Subfolders only — a symlink pointing to a directory is included
 * (otherwise `/home/user/.anywh-trabalho-home`, which is where the work
 * profile actually operates, would disappear from any listing that goes
 * through a symlink); a broken link is ignored. No dotdir filter — hidden
 * folders remain navigable, the picker isn't an "end user" listing with
 * file-manager conventions. */
export function listDirectories(rawPath: string): ListResult {
  const check = checkDirectory(rawPath);
  if (!check.ok) return check;

  let dirents;
  try {
    dirents = readdirSync(check.path, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: errorFromErrno(error) };
  }

  const entries: FsEntry[] = [];
  for (const dirent of dirents) {
    const fullPath = join(check.path, dirent.name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue; // broken symlink — ignore silently.
      }
    }
    if (isDir) entries.push({ name: dirent.name, path: fullPath });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, path: check.path, entries };
}
