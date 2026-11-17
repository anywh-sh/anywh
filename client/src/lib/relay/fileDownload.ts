import { open, save } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { listFiles, rawFileUrl, type FileEntry } from "@/lib/relay/filesClient";
import type { Profile } from "@/lib/profiles/profiles";

/** What every download accepts: an abort signal, and `onBytes` firing as
 * chunks arrive with the running total for the whole download. Each
 * download also takes an `onStart` that fires once the destination is
 * picked (a cancelled dialog never calls it) — the toast appears then, not
 * when the bytes have all landed. */
export interface DownloadOptions {
  signal?: AbortSignal;
  onBytes?: (received: number, total: number) => void;
}

/** Minimum gap between two `onBytes` reports for one body — a fast local
 * download yields a chunk every few hundred microseconds, and each report
 * re-renders the toast. The final count is always reported. */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Reads a response body chunk by chunk, reporting how much has arrived.
 * The total is the response's `Content-Length` (the relay sends it on
 * `/files/raw`), falling back to `expectedSize` — the size the file listing
 * reported — when the header is missing or unreadable, so the bar still
 * moves against an older relay.
 */
export async function readBodyWithProgress(
  response: Response,
  expectedSize: number,
  onBytes?: (received: number, total: number) => void,
  now: () => number = () => performance.now(),
): Promise<Uint8Array> {
  const header = Number(response.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : expectedSize;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes?.(bytes.byteLength, total);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = -Infinity;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const at = now();
    if (at - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = at;
      onBytes?.(received, total);
    }
  }
  onBytes?.(received, total);

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Whether a download stopped because it was cancelled, not because it
 * failed — a cancel is the user's own doing and gets no error alert. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

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
 * on a cancelled dialog. An abort through `signal` rejects with an
 * `AbortError` and writes nothing.
 */
export async function downloadFile(
  profile: Profile,
  sessionId: string,
  entry: Pick<FileEntry, "path" | "name" | "mtimeMs" | "size">,
  options: DownloadOptions & { onStart?: () => void } = {},
): Promise<boolean> {
  const target = await save({ defaultPath: entry.name });
  if (!target) return false;
  options.onStart?.();

  const bytes = await fetchFileBytes(profile, sessionId, entry, options.signal, options.onBytes);
  await writeFile(target, bytes);
  return true;
}

async function fetchFileBytes(
  profile: Profile,
  sessionId: string,
  entry: Pick<FileEntry, "path" | "mtimeMs" | "size">,
  signal: AbortSignal | undefined,
  onBytes: ((received: number, total: number) => void) | undefined,
): Promise<Uint8Array> {
  const response = await fetch(rawFileUrl(profile, sessionId, entry.path, entry.mtimeMs), { signal });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return readBodyWithProgress(response, entry.size, onBytes);
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
 * `onStart` fires once the destination is picked, with the file count and
 * the folder's total size (summed from the listing); `onProgress` after
 * every file (success or failure) with `(completed, total)`; `onBytes` as
 * bytes arrive, counted across the whole folder. The caller drives the
 * download toast (`DownloadToasts.tsx`) from them without this function
 * knowing anything about that UI. An abort through `signal` stops at the
 * file in flight — the ones already written stay — and rejects with an
 * `AbortError`.
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
  options: DownloadOptions & {
    onStart?: (files: number, bytes: number) => void;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<void> {
  const files = await collectFiles(profile, sessionId, dirPath);
  if (files.length === 0) return;

  const destParent = await open({ directory: true, recursive: true, title: `Baixar "${dirName}"` });
  if (!destParent) return;

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  options.onStart?.(files.length, totalBytes);

  let failed = 0;
  // Bytes of the files already settled; a failed file counts its listed size
  // so the bar still reaches the end.
  let settledBytes = 0;
  for (const [index, file] of files.entries()) {
    const relative = file.path.slice(dirPath.length).replace(/^\//, "");
    const targetPath = `${destParent}/${dirName}/${relative}`;
    try {
      await mkdir(targetPath.slice(0, targetPath.lastIndexOf("/")), { recursive: true });
      const bytes = await fetchFileBytes(profile, sessionId, file, options.signal, (received) =>
        options.onBytes?.(settledBytes + received, totalBytes),
      );
      await writeFile(targetPath, bytes);
    } catch (error) {
      if (isAbortError(error)) throw error;
      console.error("[anywh] failed to download file inside folder:", file.path, error);
      failed++;
    }
    settledBytes += file.size;
    options.onBytes?.(settledBytes, totalBytes);
    options.onProgress?.(index + 1, files.length);
  }
  if (failed > 0) throw new PartialFolderDownloadError(failed, files.length);
}
