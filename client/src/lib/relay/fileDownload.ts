import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { listFiles, rawFileUrl, type FileEntry } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

/**
 * Saves a session file to a location the user picks on their own machine —
 * distinct from `/files/raw` (which only ever serves bytes to the webview).
 * The native save dialog grants the fs plugin write access to whatever path
 * it returns without a broader `fs` scope (Tauri v2: the selected path is
 * added to the fs/asset-protocol scopes for the picked path only), so the
 * `fs:allow-write-file` capability here never has to allow arbitrary paths.
 * `null` back from `save()` means the user cancelled — a no-op, not an
 * error. Returns whether a file was actually written, so a caller reporting
 * "downloaded" to the user (the toast in `DownloadToasts.tsx`) doesn't fire
 * on a cancelled dialog.
 */
export async function downloadFile(profile: Profile, sessionId: string, path: string, name: string, mtimeMs: number): Promise<boolean> {
  const target = await save({ defaultPath: name });
  if (!target) return false;

  const response = await fetch(rawFileUrl(profile, sessionId, path, mtimeMs));
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(target, bytes);
  return true;
}

/** Walks `dirPath` with the tree's own lazy, one-folder-at-a-time `listFiles`
 * (relay/src/fsFiles.ts stays non-recursive) to build a flat file list.
 * `showHidden` is left at its default (off) regardless of the tree's current
 * toggle — a folder download is the one place a stray `node_modules` would
 * be expensive to pull down by accident, so it always gets the same
 * dotfile/`node_modules` filter `listFiles` applies by default. */
async function collectFiles(profile: Profile, sessionId: string, dirPath: string): Promise<FileEntry[]> {
  const { entries } = await listFiles(profile, sessionId, dirPath);
  const files: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "file") files.push(entry);
    else files.push(...(await collectFiles(profile, sessionId, entry.path)));
  }
  return files;
}

/**
 * Downloads a whole folder as a real folder on disk — not a zip the user
 * then has to extract — by walking it (`collectFiles`) and fetching each
 * file individually through the same `/files/raw` route `downloadFile` uses,
 * writing it to its place under `<destParent>/<dirName>/...`. Mirrors how
 * Zed's remote project panel downloads a directory (`download_from_remote`,
 * `project_panel.rs`): recurse, ask once for a destination, fetch file by
 * file. An empty folder is a no-op before the destination dialog even opens,
 * same as Zed. A per-file failure doesn't abort the rest of the folder — it's
 * logged and counted, so one broken symlink doesn't lose everything else
 * already fetched; the caller finds out via the thrown summary and can alert.
 *
 * `onProgress`, if given, fires after every file (success or failure) with
 * `(completed, total)` — the caller uses it to drive the download toast's
 * live count (`DownloadToasts.tsx`) without this function knowing anything
 * about that UI.
 */
/** Some of the folder arrived and some didn't. Carries the counts rather than
 * a finished sentence: the caller has the dictionary, this module doesn't. */
export class PartialFolderDownloadError extends Error {
  constructor(
    readonly failed: number,
    readonly total: number,
  ) {
    super(`failed to download ${String(failed)} of ${String(total)} files in the folder`);
    this.name = "PartialFolderDownloadError";
  }
}

export async function downloadFolder(
  profile: Profile,
  sessionId: string,
  dirPath: string,
  dirName: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const files = await collectFiles(profile, sessionId, dirPath);
  if (files.length === 0) return;

  const destParent = await open({ directory: true, recursive: true, title: `Baixar "${dirName}"` });
  if (!destParent) return;

  let failed = 0;
  for (const [index, file] of files.entries()) {
    const relative = file.path.slice(dirPath.length).replace(/^\//, "");
    const targetPath = `${destParent}/${dirName}/${relative}`;
    try {
      await mkdir(targetPath.slice(0, targetPath.lastIndexOf("/")), { recursive: true });
      const response = await fetch(rawFileUrl(profile, sessionId, file.path, file.mtimeMs));
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writeFile(targetPath, bytes);
    } catch (error) {
      console.error("[anywh] failed to download file inside folder:", file.path, error);
      failed++;
    }
    onProgress?.(index + 1, files.length);
  }
  if (failed > 0) throw new PartialFolderDownloadError(failed, files.length);
}
