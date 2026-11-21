// A bot's soul and memory: two Markdown files in a folder of its own
// (`<root>/<botId>/SOUL.md`, `MEMORY.md`), plain text the person can read
// and edit. The bot never writes them itself: it calls `set_soul`,
// `remember` and `forget`, and the relay writes the line, with the date and
// where it came from stamped by the relay, not by the model.
//
// Memory format: one fact per line, newest last, shaped
// `- YYYY-MM-DD [kind] text · from: source`. Lines that do not look like
// that (the person's own notes) are kept and shown as they are.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryKind = "rule" | "preference" | "fact";

export const MEMORY_KINDS: readonly MemoryKind[] = ["rule", "preference", "fact"];

export interface MemoryLine {
  /** Position among the memory's lines (0-based): how the person edits one. */
  index: number;
  text: string;
  kind?: MemoryKind;
  date?: string;
  source?: string;
  /** The line exactly as it is in the file. */
  raw: string;
}

export const MEMORY_LINE_MAX = 500;
/** Lines of memory a bot's prompt carries; the rest stays in the file. */
export const MEMORY_PROMPT_LINES = 200;
export const SOUL_MAX = 8000;

const MEMORY_HEADER = "# Memory\n\nOne fact per line, newest last. Written by the bot through anywh; edit freely.\n\n";
const LINE_SHAPE = /^- (\d{4}-\d{2}-\d{2}) \[(rule|preference|fact)\] (.*?)(?: · from: (.*))?$/;

/** Parses the memory file's list lines (anything else is not a fact). */
export function parseMemory(content: string): MemoryLine[] {
  const lines: MemoryLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("- ")) continue;
    const match = LINE_SHAPE.exec(trimmed);
    lines.push(
      match
        ? { index: lines.length, text: match[3].trim(), kind: match[2] as MemoryKind, date: match[1], ...(match[4] ? { source: match[4].trim() } : {}), raw: trimmed }
        : { index: lines.length, text: trimmed.slice(2).trim(), raw: trimmed },
    );
  }
  return lines;
}

export function formatMemoryLine(entry: { kind: MemoryKind; text: string; date: string; source?: string }): string {
  const text = entry.text.replace(/\s+/g, " ").trim();
  return `- ${entry.date} [${entry.kind}] ${text}${entry.source ? ` · from: ${entry.source.replace(/\s+/g, " ").trim()}` : ""}`;
}

/** The memory as the bot's prompt carries it: its first lines only. */
export function memoryForPrompt(lines: readonly MemoryLine[]): string {
  if (lines.length === 0) return "(empty)";
  const shown = lines.slice(0, MEMORY_PROMPT_LINES).map((line) => line.raw);
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join("\n")}\n(${rest} more lines in MEMORY.md not loaded)` : shown.join("\n");
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class BotFiles {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  dirFor(botId: string): string {
    return join(this.root, botId);
  }

  /** Creates the folder with a first soul and an empty memory. */
  create(botId: string, soul: string): void {
    mkdirSync(this.dirFor(botId), { recursive: true, mode: 0o700 });
    this.write(botId, "SOUL.md", soul.trim() + "\n");
    this.write(botId, "MEMORY.md", MEMORY_HEADER);
  }

  remove(botId: string): void {
    rmSync(this.dirFor(botId), { recursive: true, force: true });
  }

  readSoul(botId: string): string {
    return this.read(botId, "SOUL.md").trim();
  }

  writeSoul(botId: string, soul: string): void {
    this.write(botId, "SOUL.md", soul.trim() + "\n");
  }

  readMemory(botId: string): MemoryLine[] {
    return parseMemory(this.read(botId, "MEMORY.md"));
  }

  /** Appends a fact; a line already there (same text) is not added twice. */
  remember(botId: string, entry: { kind: MemoryKind; text: string; source?: string }): { added: boolean } {
    const lines = this.readMemory(botId);
    const key = entry.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (lines.some((line) => line.text.toLowerCase() === key)) return { added: false };
    this.writeMemory(botId, [...lines.map((line) => line.raw), formatMemoryLine({ ...entry, date: isoDate(this.now()) })]);
    return { added: true };
  }

  /** Removes the lines whose text is `text` (case and spacing ignored), or
   * that contain it when nothing matches exactly. Returns how many went. */
  forget(botId: string, text: string): number {
    const lines = this.readMemory(botId);
    const key = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (key === "") return 0;
    let gone = lines.filter((line) => line.text.toLowerCase() === key);
    if (gone.length === 0) gone = lines.filter((line) => line.text.toLowerCase().includes(key));
    if (gone.length !== 1 && !lines.some((line) => line.text.toLowerCase() === key)) return gone.length > 1 ? -gone.length : 0;
    const dropped = new Set(gone.map((line) => line.index));
    this.writeMemory(botId, lines.filter((line) => !dropped.has(line.index)).map((line) => line.raw));
    return gone.length;
  }

  /** The person edits or deletes one line, by index. `false` when there is
   * no such line. */
  editLine(botId: string, index: number, text: string | null): boolean {
    const lines = this.readMemory(botId);
    const line = lines[index];
    if (!line) return false;
    const next = lines.flatMap((each) => {
      if (each.index !== index) return [each.raw];
      if (text === null) return [];
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean === "") return [];
      return [line.kind && line.date ? formatMemoryLine({ kind: line.kind, text: clean, date: line.date, ...(line.source ? { source: line.source } : {}) }) : `- ${clean}`];
    });
    this.writeMemory(botId, next);
    return true;
  }

  private writeMemory(botId: string, lines: readonly string[]): void {
    this.write(botId, "MEMORY.md", MEMORY_HEADER + lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  }

  private read(botId: string, file: string): string {
    try {
      return readFileSync(join(this.dirFor(botId), file), "utf8");
    } catch {
      return "";
    }
  }

  private write(botId: string, file: string, content: string): void {
    mkdirSync(this.dirFor(botId), { recursive: true, mode: 0o700 });
    const path = join(this.dirFor(botId), file);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  }
}
