// What the relay created, kept on disk: the only list the worktree cleanup
// ever acts on. A record is written (state `creating`) before `git worktree
// add` runs and `removing` before a removal starts, so a crash between steps
// leaves a record saying what was in progress for the next start to finish.
// Never touches git; the rules are in worktreePolicy.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorktreeRecord, WorktreeState } from "./worktreePolicy.js";

const STATES: ReadonlySet<string> = new Set<WorktreeState>(["creating", "created", "retained", "removing"]);

function isRecord(value: unknown): value is WorktreeRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const base = v.base as Record<string, unknown> | undefined;
  return (
    ["id", "repoRoot", "path", "branch", "roomId", "agentId"].every((key) => typeof v[key] === "string" && v[key] !== "") &&
    typeof v.createdAt === "number" &&
    typeof v.state === "string" &&
    STATES.has(v.state) &&
    typeof base === "object" &&
    base !== null &&
    typeof base.sha === "string" &&
    (base.ref === undefined || typeof base.ref === "string")
  );
}

/** `<profile>.json` → `<profile>-worktrees.json`, beside the sessions file. */
export function worktreeRegistryPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-worktrees.json` : `${sessionsFile}-worktrees.json`;
}

export class WorktreeRegistry {
  private records: WorktreeRecord[] = [];

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) this.records = parsed.filter(isRecord);
    } catch (error) {
      // Missing: a new profile. Unreadable: kept aside so the next write does
      // not erase what it says; nothing is acted on meanwhile.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          renameSync(file, `${file}.corrupt`);
        } catch {
          // left where it is
        }
      }
    }
  }

  all(): readonly WorktreeRecord[] {
    return this.records;
  }

  get(id: string): WorktreeRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  forAgent(agentId: string): WorktreeRecord[] {
    return this.records.filter((record) => record.agentId === agentId);
  }

  forRoom(roomId: string): WorktreeRecord[] {
    return this.records.filter((record) => record.roomId === roomId);
  }

  /** Writes before returning: the point of the registry is that it is on disk first. */
  put(record: WorktreeRecord): void {
    const at = this.records.findIndex((existing) => existing.id === record.id);
    if (at >= 0) this.records[at] = record;
    else this.records.push(record);
    this.save();
  }

  delete(id: string): void {
    this.records = this.records.filter((record) => record.id !== id);
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
