import { watch, type FSWatcher } from "node:fs";
import { resolveWithinRoot } from "./fsFiles.js";

export type FilesWatchMessage = { type: "dir_changed"; path: string } | { type: "file_changed"; path: string };

// A single write reliably fires more than one raw fs event (measured while
// planning this feature) — this collapses them into one
// notification per path.
const DEBOUNCE_MS = 150;

/**
 * One instance per `/files` WS connection — tracks
 * exactly the directories/files the client says are visible right now
 * (expanded tree nodes + open tabs) and keeps a non-recursive `fs.watch`
 * open for each; recursive watching doesn't scale once `node_modules` is
 * involved (measured), so only what's actually on screen gets a
 * watcher. `update` always receives the client's *full* current set, not an
 * incremental add/remove — it diffs against what's already watched and
 * opens/closes only the difference, which makes it idempotent and immune to
 * the client and relay ever disagreeing about state.
 */
export class FilesWatchSession {
  private readonly dirWatchers = new Map<string, FSWatcher>();
  private readonly fileWatchers = new Map<string, FSWatcher>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly root: string,
    private readonly onChange: (message: FilesWatchMessage) => void,
  ) {}

  update(dirs: string[], files: string[]): void {
    this.reconcile(this.dirWatchers, dirs, "dir_changed");
    this.reconcile(this.fileWatchers, files, "file_changed");
  }

  private reconcile(map: Map<string, FSWatcher>, wanted: string[], kind: FilesWatchMessage["type"]): void {
    const wantedSet = new Set(wanted);
    for (const [path, watcher] of map) {
      if (!wantedSet.has(path)) {
        watcher.close();
        map.delete(path);
      }
    }

    for (const rawPath of wanted) {
      if (map.has(rawPath)) continue;
      // Same contract as the HTTP endpoints — a path outside the session's
      // root (or one that no longer resolves) never becomes a watcher.
      const resolved = resolveWithinRoot(this.root, rawPath);
      if (!resolved.ok) continue;
      try {
        const watcher = watch(resolved.path, () => this.scheduleNotify(kind, rawPath));
        watcher.on("error", () => {
          watcher.close();
          map.delete(rawPath);
        });
        map.set(rawPath, watcher);
      } catch {
        // Disappeared between the client asking and the watch actually
        // opening — skipped silently, same as a directory listing race.
      }
    }
  }

  private scheduleNotify(kind: FilesWatchMessage["type"], path: string): void {
    const key = `${kind}:${path}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.onChange(kind === "dir_changed" ? { type: "dir_changed", path } : { type: "file_changed", path });
      }, DEBOUNCE_MS),
    );
  }

  /** Everything this connection opened dies with it — the relay keeps no
   * global watcher registry, same lifecycle as `/terminal`'s pty. */
  close(): void {
    for (const watcher of this.dirWatchers.values()) watcher.close();
    for (const watcher of this.fileWatchers.values()) watcher.close();
    this.dirWatchers.clear();
    this.fileWatchers.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}
