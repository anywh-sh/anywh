// A room's context on disk: one folder per room holding the files people and
// agents put there, and the `INDEX.md` the relay keeps up to date, the single
// thing handed to every agent (see roomContextIndex.ts). Only the relay
// writes the index and the manifest it is built from; agents just read the
// folder, and may drop a result file into it, which the relay adopts the next
// time it looks (`sync`).
//
// A PDF is extracted to text once, on arrival, and the text sits beside it.
// Removing an item deletes its file and its extraction and rewrites the index;
// what an agent already read stays in that agent's conversation.
//
// Every write is atomic (temp file, rename) and the index and manifest are
// rebuilt from the folder's own state, so a crash between a file landing and
// the index catching up is repaired by the next `sync`.
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ExtractedText } from "../host/pdfText.js";
import { LARGE_ITEM_TOKENS, buildIndex, estimateTokens, summarize, type ContextItem } from "./roomContextIndex.js";

export const INDEX_FILE = "INDEX.md";
const MANIFEST_FILE = ".items.json";
/** Largest single item, and most items per room. */
/** The manifest and the index are far below this; a bigger one was tampered with. */
const OWNED_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const CONTEXT_ITEM_MAX_BYTES = 50 * 1024 * 1024;
export const CONTEXT_ITEMS_MAX = 200;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"]);
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface RoomContextStoreOptions {
  /** Folder holding one subfolder per room. */
  readonly root: string;
  /** Extracts a PDF's text; absent or failing leaves the PDF as it is. */
  readonly extractPdf?: (path: string) => Promise<ExtractedText | undefined>;
  readonly now?: () => number;
}

export interface AddItemInput {
  name: string;
  data: Buffer;
  author: string;
  summary?: string;
}

export type AddItemResult = { ok: true; item: ContextItem; warning?: string } | { ok: false; status: number; error: string };

/** At most `max` bytes of UTF-8, never cutting a character. */
function truncateBytes(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char) > max) break;
    out += char;
  }
  return out;
}

/** The text of a file the relay owns but agents can reach: only a regular,
 * small file is read (a FIFO would block the whole relay, a link to a device
 * or a huge file would fill its memory); anything else is cleared away. */
function readOwned(path: string): string | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stats.isFile() || stats.size > OWNED_FILE_MAX_BYTES) {
    rmSync(path, { recursive: true, force: true });
    return undefined;
  }
  return readFileSync(path, "utf8");
}

/** A file name that is one safe path segment, or `undefined`. */
export function sanitizeItemName(raw: string): string | undefined {
  const base = basename(raw.replace(/\\/g, "/")).normalize("NFC");
  const cleaned = truncateBytes(base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim(), 180);
  if (cleaned === "" || cleaned === INDEX_FILE || cleaned === MANIFEST_FILE) return undefined;
  return cleaned;
}

/** One path segment that is not a special name: what a manifest may hold. The
 * manifest sits in a folder agents can write to, so nothing in it is trusted
 * to be a name inside that folder until it is checked. */
function isSafeSegment(name: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return name !== "" && Buffer.byteLength(name) <= 255 && !/[\x00-\x1f\x7f]/.test(name) && name !== "." && name !== ".." && !/[\\/\0]/.test(name) && name !== INDEX_FILE && name !== MANIFEST_FILE && !name.startsWith(".tmp-");
}

function isItem(value: unknown): value is ContextItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    isSafeSegment(v.name) &&
    ["text", "pdf", "image", "binary"].includes(v.kind as string) &&
    typeof v.bytes === "number" &&
    typeof v.author === "string" &&
    typeof v.summary === "string" &&
    typeof v.at === "number" &&
    (v.extraction === undefined || (typeof v.extraction === "string" && isSafeSegment(v.extraction)))
  );
}

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** The first bytes of a file, without reading the rest of it. */
function readHead(path: string, size: number): Buffer {
  // Never blocks on a FIFO swapped in since the check, never follows a link.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(Math.min(size, 4096));
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

function looksLikeText(data: Buffer): boolean {
  const head = data.subarray(0, 4096);
  return !head.includes(0) && Buffer.from(head.toString("utf8"), "utf8").length >= head.length - 3;
}

export class RoomContextStore {
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Rooms deleted by this process: a late upload must not bring one back. */
  private readonly gone = new Set<string>();

  constructor(private readonly options: RoomContextStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The folder of a room; throws for an id that is not a plain id. */
  dirFor(roomId: string): string {
    if (!ROOM_ID.test(roomId)) throw new Error("invalid room id");
    return join(this.options.root, roomId);
  }

  /** Runs `task` after every earlier one for the same room has finished. */
  private serial<T>(roomId: string, task: () => T | Promise<T>): Promise<T> {
    const run = (this.queues.get(roomId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    this.queues.set(roomId, tail);
    void tail.then(() => {
      if (this.queues.get(roomId) === tail) this.queues.delete(roomId);
    });
    return run;
  }

  private readManifest(dir: string): ContextItem[] {
    try {
      const parsed = JSON.parse(readOwned(join(dir, MANIFEST_FILE)) ?? "{}") as { items?: unknown };
      return Array.isArray(parsed.items) ? parsed.items.filter(isItem) : [];
    } catch {
      return [];
    }
  }

  private writeAtomic(path: string, content: string | Buffer): void {
    // A name nobody can plant a link at ("wx" refuses an existing one), renamed
    // over the target: the rename replaces a link rather than writing through it.
    // (A directory an agent put where the target goes is cleared first.)
    try {
      if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
    } catch {
      // not there
    }
    const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  }

  private persist(dir: string, items: readonly ContextItem[]): void {
    this.writeAtomic(join(dir, MANIFEST_FILE), JSON.stringify({ items }));
    this.writeAtomic(join(dir, INDEX_FILE), buildIndex(dir, items));
  }

  private uniqueName(dir: string, wanted: string, taken: ReadonlySet<string>): string {
    const ext = extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? wanted : `${stem}-${n}${ext}`;
      if (taken.has(candidate)) continue;
      try {
        statSync(join(dir, candidate));
      } catch {
        return candidate;
      }
    }
  }

  /** The names a manifest accounts for: items and their extractions. */
  private namesOf(items: readonly ContextItem[]): Set<string> {
    const names = new Set<string>();
    for (const item of items) {
      names.add(item.name);
      if (item.extraction) names.add(item.extraction);
    }
    return names;
  }

  private describeText(text: string, summary: string | undefined): Pick<ContextItem, "lines" | "summary" | "largeTokens"> {
    const tokens = estimateTokens(text.length);
    return { lines: countLines(text), summary: summary ?? summarize(text), ...(tokens > LARGE_ITEM_TOKENS ? { largeTokens: tokens } : {}) };
  }

  add(roomId: string, input: AddItemInput): Promise<AddItemResult> {
    return this.serial(roomId, async () => {
      const name = sanitizeItemName(input.name);
      if (!name) return { ok: false, status: 400, error: "name is not a usable file name" };
      if (this.gone.has(roomId)) return { ok: false, status: 404, error: "room not found" };
      if (input.data.length === 0) return { ok: false, status: 400, error: "the file is empty" };
      if (input.data.length > CONTEXT_ITEM_MAX_BYTES) return { ok: false, status: 413, error: `the file is larger than ${CONTEXT_ITEM_MAX_BYTES} bytes` };
      const dir = this.dirFor(roomId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const items = this.readManifest(dir);
      if (items.length >= CONTEXT_ITEMS_MAX) return { ok: false, status: 409, error: `the room already has ${CONTEXT_ITEMS_MAX} items` };
      const taken = this.namesOf(items);
      const stored = this.uniqueName(dir, name, taken);
      this.writeAtomic(join(dir, stored), input.data);
      const ext = extname(stored).toLowerCase();
      let item: ContextItem;
      let extractionFailed = false;
      if (ext === ".pdf") {
        const extracted = await this.options.extractPdf?.(join(dir, stored));
        if (extracted) {
          const extraction = this.uniqueName(dir, `${stored}.txt`, new Set([...taken, stored]));
          this.writeAtomic(join(dir, extraction), extracted.text);
          item = { name: stored, kind: "pdf", bytes: input.data.length, pages: extracted.pages, extraction, author: input.author, at: this.now(), ...this.describeText(extracted.text, input.summary) };
        } else {
          extractionFailed = true;
          item = { name: stored, kind: "pdf", bytes: input.data.length, author: input.author, at: this.now(), summary: input.summary ?? "PDF whose text could not be extracted (is pdftotext installed?)" };
        }
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        item = { name: stored, kind: "image", bytes: input.data.length, author: input.author, at: this.now(), summary: input.summary ?? "image; open it with Read to see it" };
      } else if (looksLikeText(input.data)) {
        item = { name: stored, kind: "text", bytes: input.data.length, author: input.author, at: this.now(), ...this.describeText(input.data.toString("utf8"), input.summary) };
      } else {
        item = { name: stored, kind: "binary", bytes: input.data.length, author: input.author, at: this.now(), summary: input.summary ?? "binary file" };
      }
      this.persist(dir, [...items, item]);
      const warning =
        item.largeTokens !== undefined
          ? `This item is about ${Math.round(item.largeTokens / 1000)}k tokens: agents will read parts of it on demand.`
          : extractionFailed
            ? "The PDF's text could not be extracted; agents can only open it as a PDF."
            : undefined;
      return { ok: true, item, ...(warning ? { warning } : {}) };
    });
  }

  /** Deletes an item's file and extraction and rewrites the index. `false`
   * when the room has no such item. */
  remove(roomId: string, name: string): Promise<boolean> {
    return this.serial(roomId, () => {
      const dir = this.dirFor(roomId);
      const items = this.readManifest(dir);
      const item = items.find((candidate) => candidate.name === name);
      if (!item) return false;
      for (const file of [item.name, item.extraction]) if (file) rmSync(join(dir, file), { recursive: true, force: true });
      this.persist(
        dir,
        items.filter((candidate) => candidate !== item),
      );
      return true;
    });
  }

  /**
   * Brings the manifest and the index in line with the folder: a file nobody
   * registered (an agent's result, an interrupted upload) is adopted, an item
   * whose file is gone is dropped, and one whose size changed is re-read.
   * `attribution` names who to credit for adopted files an agent listed as
   * its artifacts.
   */
  sync(roomId: string, attribution?: { author: string; artifacts: readonly string[] }): Promise<ContextItem[]> {
    return this.serial(roomId, () => {
      const dir = this.dirFor(roomId);
      if (this.gone.has(roomId)) return [];
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      const before = this.readManifest(dir);
      const known = this.namesOf(before);
      const present = new Set<string>();
      for (const entry of entries) {
        if (entry.startsWith(".tmp-")) {
          // A write the relay was killed in the middle of.
          rmSync(join(dir, entry), { recursive: true, force: true });
          continue;
        }
        if (entry.startsWith(".") || entry === INDEX_FILE) continue;
        let stats;
        try {
          stats = lstatSync(join(dir, entry));
        } catch {
          continue;
        }
        if (stats.isFile()) present.add(entry);
      }
      let changed = false;
      const items: ContextItem[] = [];
      for (let item of before) {
        if (!present.has(item.name)) {
          changed = true;
          if (item.extraction) rmSync(join(dir, item.extraction), { recursive: true, force: true });
          continue;
        }
        // Seen first by a sync with no one to credit: the agent that lists it
        // in its report is credited now.
        if (attribution && (item.author === "agent" || item.author === "unknown") && attribution.artifacts.some((artifact) => basename(artifact) === item.name)) {
          item = { ...item, author: attribution.author };
          changed = true;
        }
        // One file an agent made unreadable (or removed meanwhile) keeps its
        // old line; it does not stop the others from being looked at.
        try {
          const size = statSync(join(dir, item.name)).size;
          if (size !== item.bytes && item.kind === "text" && size <= CONTEXT_ITEM_MAX_BYTES) {
            const text = readFileSync(join(dir, item.name), "utf8");
            const { largeTokens: _old, ...rest } = item;
            void _old;
            items.push({ ...rest, bytes: size, ...this.describeText(text, undefined) });
            changed = true;
            continue;
          }
        } catch {
          // keeps its line
        }
        items.push(item);
      }
      for (const name of [...present].sort()) {
        if (known.has(name) || items.length >= CONTEXT_ITEMS_MAX) continue;
        if (!isSafeSegment(name)) continue;
        // A file past the cap is not adopted (an agent's runaway output must
        // not be read whole into the relay); one that cannot be read is skipped.
        let size: number;
        let head: Buffer;
        try {
          size = statSync(join(dir, name)).size;
          if (size > CONTEXT_ITEM_MAX_BYTES || size === 0) continue;
          head = readHead(join(dir, name), size);
        } catch {
          continue;
        }
        const ext = extname(name).toLowerCase();
        const credited = attribution?.artifacts.some((artifact) => basename(artifact) === name || artifact === join(dir, name));
        const author = credited ? attribution!.author : /^result/i.test(name) ? "agent" : "unknown";
        const base = { name, bytes: size, author, at: this.now() };
        if (ext === ".pdf") items.push({ ...base, kind: "pdf", summary: "PDF added by an agent" });
        else if (IMAGE_EXTENSIONS.has(ext)) items.push({ ...base, kind: "image", summary: "image; open it with Read to see it" });
        else if (looksLikeText(head)) {
          let text: string;
          try {
            text = readFileSync(join(dir, name), "utf8");
          } catch {
            continue;
          }
          items.push({ ...base, kind: "text", ...this.describeText(text, undefined) });
        } else items.push({ ...base, kind: "binary", summary: "binary file" });
        changed = true;
      }
      let indexCurrent = false;
      try {
        indexCurrent = readOwned(join(dir, INDEX_FILE)) === buildIndex(dir, items);
      } catch {
        // missing: written below
      }
      if (changed || !indexCurrent) this.persist(dir, items);
      return items;
    });
  }

  async list(roomId: string): Promise<ContextItem[]> {
    return this.sync(roomId);
  }

  /** The index as the agents see it (after syncing with the folder). */
  async index(roomId: string): Promise<string> {
    await this.sync(roomId);
    try {
      return readOwned(join(this.dirFor(roomId), INDEX_FILE)) ?? buildIndex(this.dirFor(roomId), []);
    } catch {
      return buildIndex(this.dirFor(roomId), []);
    }
  }

  /** The index as it stands on disk, without looking at the folder: what a
   * prompt built right now carries. Every change the relay itself makes
   * rewrites it, and `sync` catches up with what agents wrote. */
  indexNow(roomId: string): string {
    const dir = this.dirFor(roomId);
    try {
      return readOwned(join(dir, INDEX_FILE)) ?? buildIndex(dir, []);
    } catch {
      return buildIndex(dir, []);
    }
  }

  /** Items the relay learned of after `at` (epoch ms), oldest first. */
  itemsAfter(roomId: string, at: number): ContextItem[] {
    return this.readManifest(this.dirFor(roomId))
      .filter((item) => item.at > at)
      .sort((a, b) => a.at - b.at);
  }

  /** The folder and everything in it (the room is gone). */
  deleteRoom(roomId: string): void {
    this.gone.add(roomId);
    rmSync(this.dirFor(roomId), { recursive: true, force: true });
  }

  /** Removes the folders of rooms that no longer exist; returns their ids. */
  pruneOrphans(liveRoomIds: ReadonlySet<string>): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.options.root);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!ROOM_ID.test(entry) || liveRoomIds.has(entry)) continue;
      try {
        if (!lstatSync(join(this.options.root, entry)).isDirectory()) continue;
        rmSync(join(this.options.root, entry), { recursive: true, force: true });
        removed.push(entry);
      } catch {
        // left for the next start
      }
    }
    return removed;
  }
}
