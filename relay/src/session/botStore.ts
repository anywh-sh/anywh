// Where the bots of a profile are kept: one JSON file beside the sessions
// file (`<profile>-bots.json`), written whole and atomically on every change.
// A record that does not validate is dropped on load (and the file rewritten
// without it); a file that does not parse at all is set aside, never
// overwritten, so a corrupt write cannot silently wipe every bot.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isBotRecord, type BotRecord } from "./bot.js";

export function botsPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-bots.json` : `${sessionsFile}-bots.json`;
}

export class BotStore {
  private bots: BotRecord[] = [];
  private readonly listeners: ((bot: BotRecord | undefined, id: string) => void)[] = [];

  constructor(
    private readonly filePath: string,
    now: () => number = Date.now,
  ) {
    if (!existsSync(filePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      const aside = `${filePath}.corrupt-${now()}`;
      console.warn(`[relay] the bots file could not be read (${(error as Error).message}); moved it to ${aside} and started empty`);
      renameSync(filePath, aside);
      return;
    }
    const raw = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { bots?: unknown }).bots) ? (parsed as { bots: unknown[] }).bots : [];
    this.bots = raw.filter(isBotRecord).map((bot) => structuredClone(bot));
    if (this.bots.length !== raw.length) {
      console.warn(`[relay] dropped ${raw.length - this.bots.length} bot record(s) that did not validate`);
      this.persist();
    }
  }

  list(): BotRecord[] {
    return this.bots.map((bot) => structuredClone(bot));
  }

  get(id: string): BotRecord | undefined {
    const bot = this.bots.find((each) => each.id === id);
    return bot && structuredClone(bot);
  }

  byRoom(roomId: string): BotRecord | undefined {
    const bot = this.bots.find((each) => each.roomId === roomId);
    return bot && structuredClone(bot);
  }

  isBotRoom(roomId: string): boolean {
    return this.bots.some((each) => each.roomId === roomId);
  }

  /** Whether a task of the bot of `roomId` that is not over holds the worker.
   * Read in place (no copy): it runs for every member of every snapshot. */
  hasOpenTaskFor(roomId: string, workerId: string): boolean {
    const bot = this.bots.find((each) => each.roomId === roomId);
    return bot?.tasks.some((task) => task.status !== "done" && task.status !== "canceled" && task.workerIds.includes(workerId)) ?? false;
  }

  /** Tells the listeners the bot changed outside this file (its soul or
   * memory, a run starting) without rewriting the file. */
  touch(id: string): void {
    const bot = this.get(id);
    if (!bot) return;
    for (const listener of this.listeners) listener(bot, id);
  }

  /** Writes `bot` (new or replacing the one with its id). */
  put(bot: BotRecord): void {
    const index = this.bots.findIndex((each) => each.id === bot.id);
    if (index === -1) this.bots.push(structuredClone(bot));
    else this.bots[index] = structuredClone(bot);
    this.persist();
    for (const listener of this.listeners) listener(structuredClone(bot), bot.id);
  }

  /** Applies `change` to the bot `id` and writes it; `undefined` when there
   * is no such bot. */
  update(id: string, change: (bot: BotRecord) => BotRecord): BotRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = change(current);
    this.put(next);
    return next;
  }

  delete(id: string): boolean {
    const before = this.bots.length;
    this.bots = this.bots.filter((each) => each.id !== id);
    if (this.bots.length === before) return false;
    this.persist();
    for (const listener of this.listeners) listener(undefined, id);
    return true;
  }

  onChange(listener: (bot: BotRecord | undefined, id: string) => void): void {
    this.listeners.push(listener);
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, bots: this.bots }), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}
