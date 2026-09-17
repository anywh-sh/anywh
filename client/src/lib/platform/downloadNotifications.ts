/**
 * Tracks in-flight/just-finished downloads for the bottom-right toast stack
 * (`DownloadToasts.tsx`) — same shape as `profileRevocation.ts`'s
 * module-level store (`subscribe`/`notify`, read via `useSyncExternalStore`),
 * needed here because downloads are kicked off from deep inside `FileTree`
 * (a row's context menu) while the toast itself mounts once at the app
 * root — a plain prop can't bridge that.
 *
 * A lone-file download (`downloadFile`, used directly by a file row's
 * "Baixar" and each iteration of the bulk multi-select download) never goes
 * through a "downloading" phase here — it's fast enough that Zed's own
 * project panel (the model for this whole feature) only ever
 * shows the completed "downloaded" toast for it. A folder or multi-select
 * batch is different: `total` is known up front and each file's completion
 * is visible, so the count ticks up live while it runs.
 *
 * A finished toast stays until the user dismisses it via the toast's own
 * close button (`dismissDownloadNotification`) — no auto-dismiss timer.
 */
export interface DownloadNotification {
  id: string;
  total: number;
  current: number;
  done: boolean;
  /** Set only for a lone-file download — the batch case's text never names
   * individual files, just the running count. */
  fileName?: string;
}

let notifications: DownloadNotification[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function nextId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Starts the "Baixando X/Y arquivos" toast for a folder or bulk
 * multi-select download — call `tickBatchDownload` as each file finishes
 * and `finishBatchDownload` once the whole batch settles. */
export function startBatchDownload(total: number): string {
  const id = nextId();
  notifications = [...notifications, { id, total, current: 0, done: false }];
  notify();
  return id;
}

export function tickBatchDownload(id: string, current: number): void {
  notifications = notifications.map((entry) => (entry.id === id ? { ...entry, current } : entry));
  notify();
}

/** Flips the toast to "Baixado X/Y arquivos". Safe to call even if the
 * batch never ticked past 0 (an all-failed batch still gets a completion
 * toast — per-file failures are already surfaced separately via
 * `window.alert`). Stays on screen until the user dismisses it. */
export function finishBatchDownload(id: string): void {
  notifications = notifications.map((entry) => (entry.id === id ? { ...entry, done: true } : entry));
  notify();
}

/** Lone-file download, reported only on success — straight into "done"
 * state, no separate "downloading" phase (see module doc comment). Stays on
 * screen until the user dismisses it. */
export function notifyFileDownloaded(fileName: string): void {
  const id = nextId();
  notifications = [...notifications, { id, total: 1, current: 1, done: true, fileName }];
  notify();
}

export function dismissDownloadNotification(id: string): void {
  notifications = notifications.filter((entry) => entry.id !== id);
  notify();
}

export function getDownloadNotifications(): DownloadNotification[] {
  return notifications;
}

export function subscribeDownloadNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
