/**
 * Tracks in-flight/just-finished downloads for the toast stack
 * (`DownloadToasts.tsx`) — same shape as `profileRevocation.ts`'s
 * module-level store (`subscribe`/`notify`, read via `useSyncExternalStore`),
 * needed here because downloads are kicked off from deep inside `FileTree`
 * (a row's context menu) while the toasts mount once at the app root — a
 * plain prop can't bridge that.
 *
 * Every download — a lone file, a folder, a multi-select batch — gets its
 * toast as soon as its destination is picked, then reports bytes as they
 * arrive, so a large file shows a moving bar instead of nothing until it
 * lands. A batch also counts finished files.
 *
 * A running download can be cancelled from its toast (`cancelDownload`),
 * which aborts it through the callback registered at start and removes the
 * toast. A finished toast stays until the user dismisses it — no
 * auto-dismiss timer.
 */
export interface DownloadNotification {
  id: string;
  /** Files in the download, and how many have finished. 1 for a lone file. */
  total: number;
  current: number;
  /** Size of the whole download in bytes; 0 when unknown. */
  bytesTotal: number;
  bytesReceived: number;
  done: boolean;
  /** Set only for a lone-file download — the batch case's text never names
   * individual files, just the running count. */
  fileName?: string;
}

let notifications: DownloadNotification[] = [];
const cancels = new Map<string, () => void>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function nextId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function update(id: string, patch: Partial<DownloadNotification>): void {
  notifications = notifications.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  notify();
}

function start(entry: Omit<DownloadNotification, "id" | "current" | "bytesReceived" | "done">, cancel?: () => void): string {
  const id = nextId();
  notifications = [...notifications, { ...entry, id, current: 0, bytesReceived: 0, done: false }];
  if (cancel) cancels.set(id, cancel);
  notify();
  return id;
}

/** Starts the toast for one file, once its save location is picked. */
export function startFileDownload(fileName: string, bytesTotal: number, cancel?: () => void): string {
  return start({ fileName, total: 1, bytesTotal }, cancel);
}

/** Starts the "Downloading X/Y files" toast for a folder or a multi-select
 * download — call `tickBatchDownload` as each file finishes. */
export function startBatchDownload(total: number, bytesTotal: number, cancel?: () => void): string {
  return start({ total, bytesTotal }, cancel);
}

export function tickBatchDownload(id: string, current: number): void {
  update(id, { current });
}

/** Bytes received so far across the whole download. `bytesTotal` replaces
 * the estimate given at start when the server reported a real size. */
export function reportDownloadBytes(id: string, bytesReceived: number, bytesTotal?: number): void {
  update(id, bytesTotal === undefined ? { bytesReceived } : { bytesReceived, bytesTotal });
}

/** Flips the toast to its finished phrasing. Safe to call even if the
 * download never ticked past 0 (an all-failed batch still gets a completion
 * toast — per-file failures are already surfaced separately via
 * `window.alert`). Stays on screen until the user dismisses it. */
export function finishDownload(id: string): void {
  cancels.delete(id);
  const entry = notifications.find((candidate) => candidate.id === id);
  if (!entry) return;
  update(id, { done: true, current: entry.fileName ? 1 : entry.current });
}

export function dismissDownloadNotification(id: string): void {
  cancels.delete(id);
  notifications = notifications.filter((entry) => entry.id !== id);
  notify();
}

/** Aborts a running download and removes its toast. */
export function cancelDownload(id: string): void {
  const cancel = cancels.get(id);
  dismissDownloadNotification(id);
  cancel?.();
}

export function getDownloadNotifications(): DownloadNotification[] {
  return notifications;
}

export function subscribeDownloadNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
