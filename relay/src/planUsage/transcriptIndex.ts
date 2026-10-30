// A cheap, cached view of a profile's Claude transcripts
// (`${CLAUDE_CONFIG_DIR:-<home>/.claude}/projects/**/*.jsonl`), shared by the
// two readers that need it: local activity (any write after an instant) and
// limit refusals (transcriptLimits.ts). A busy machine has well over a
// thousand transcripts, and walking them all every minute is thousands of
// `stat`s per profile, so:
//
// - a full walk happens at most every `fullRescanMs` (5 min);
// - in between, a refresh (at most every `refreshFloorMs`, 1 min) stats the
//   root and each project directory — a new session file changes its
//   directory's mtime, which re-walks that project alone — and the
//   `hotFiles` most recently modified transcripts, where appends land;
// - an older transcript resumed in the meantime is seen at the next full
//   walk, at most 5 min late.
//
// Only `readdir`/`stat`: nothing here opens a transcript.
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface TranscriptIndexOptions {
  /** The `projects` directory (`claudeProjectsDir`). */
  root: string;
  now?: () => number;
  fullRescanMs?: number;
  refreshFloorMs?: number;
  hotFiles?: number;
}

export const TRANSCRIPT_FULL_RESCAN_MS = 5 * 60_000;
export const TRANSCRIPT_REFRESH_FLOOR_MS = 60_000;
export const TRANSCRIPT_HOT_FILES = 20;
// projects/<project>/<session>/subagents/*.jsonl is four levels down.
const MAX_DEPTH = 4;

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function walk(dir: string, depth: number, out: Map<string, TranscriptFile>): Promise<void> {
  for (const entry of await list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(path, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const info = await stat(path);
        out.set(path, { path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Deleted between the listing and the stat.
      }
    }
  }
}

export class TranscriptIndex {
  private readonly files = new Map<string, TranscriptFile>();
  /** Each project directory's mtime, as of the last time it was walked. */
  private readonly projects = new Map<string, number>();
  private rootMtime: number | null = null;
  private lastFullAt: number | null = null;
  private lastRefreshAt: number | null = null;
  private sorted: TranscriptFile[] = [];
  private refreshing?: Promise<void>;
  /** `stat`/`readdir` calls made, for the tests that bound them. */
  operations = 0;

  constructor(private readonly options: TranscriptIndexOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Every known transcript, most recently modified first, as of the last
   * refresh — refreshed first when the floor allows. Never rejects. */
  async list(): Promise<readonly TranscriptFile[]> {
    const now = this.now;
    if (this.lastRefreshAt === null || now - this.lastRefreshAt >= (this.options.refreshFloorMs ?? TRANSCRIPT_REFRESH_FLOOR_MS)) {
      this.refreshing ??= this.refresh(now).finally(() => {
        this.refreshing = undefined;
      });
      await this.refreshing;
    }
    return this.sorted;
  }

  private async refresh(now: number): Promise<void> {
    this.lastRefreshAt = now;
    const root = this.options.root;
    const rootMtime = await this.count(mtimeOf(root));
    const fullDue = this.lastFullAt === null || now - this.lastFullAt >= (this.options.fullRescanMs ?? TRANSCRIPT_FULL_RESCAN_MS);
    if (fullDue || rootMtime !== this.rootMtime) {
      await this.full(now, rootMtime);
    } else {
      for (const [project, known] of this.projects) {
        const mtime = await this.count(mtimeOf(project));
        if (mtime === known) continue;
        this.forget(project);
        if (mtime === null) {
          this.projects.delete(project);
          continue;
        }
        this.projects.set(project, mtime);
        await this.walkCounted(project, 2);
      }
      for (const file of this.hot()) {
        try {
          const info = await this.count(stat(file.path));
          this.files.set(file.path, { path: file.path, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          this.files.delete(file.path);
        }
      }
    }
    this.sorted = [...this.files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private async full(now: number, rootMtime: number | null): Promise<void> {
    this.lastFullAt = now;
    this.rootMtime = rootMtime;
    this.files.clear();
    this.projects.clear();
    for (const entry of await this.count(list(this.options.root))) {
      if (!entry.isDirectory()) continue;
      const project = join(this.options.root, entry.name);
      const mtime = await this.count(mtimeOf(project));
      if (mtime === null) continue;
      this.projects.set(project, mtime);
      await this.walkCounted(project, 2);
    }
  }

  private async walkCounted(dir: string, depth: number): Promise<void> {
    const found = new Map<string, TranscriptFile>();
    await walk(dir, depth, found);
    this.operations += found.size + 1;
    for (const [path, file] of found) this.files.set(path, file);
  }

  private forget(project: string): void {
    const prefix = project + sep;
    for (const path of this.files.keys()) if (path.startsWith(prefix)) this.files.delete(path);
  }

  private hot(): TranscriptFile[] {
    return this.sorted.slice(0, this.options.hotFiles ?? TRANSCRIPT_HOT_FILES);
  }

  private count<T>(operation: Promise<T>): Promise<T> {
    this.operations += 1;
    return operation;
  }
}

/** Whether a transcript of the index was modified after `since`. */
export async function transcriptActivitySince(index: TranscriptIndex, since: number): Promise<boolean> {
  return (await index.list()).some((file) => file.mtimeMs > since);
}
