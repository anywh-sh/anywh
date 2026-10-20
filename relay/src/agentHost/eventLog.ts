// Append-only log of one agent's events: everything the agent CLI printed on
// stdout plus the host's own `host_*` events, one JSON record per line:
//
//   {"seq":12,"off":4031,"t":1792458155845,"ev":{...}}
//
// `seq` counts records; `off` is a LOGICAL byte offset — the position the
// record had when it was written, which never changes afterwards. A client
// resumes from the `next` (= off + line length) of the last record it
// processed. Because every record carries its own `off`, a sealed segment can
// be compacted (lines dropped) without invalidating any cursor: a reader skips
// records whose `off` is below its cursor instead of seeking to a byte.
//
// The log is split into segment files named `<baseOffset>-<baseSeq>.jsonl`.
// Only the newest segment is appended to. When it grows past `segmentBytes`
// it is sealed, compacted (the CLI's partial-message `stream_event` lines are
// dropped: the complete `assistant` message that follows them carries the
// same content), and a new segment starts. When the segments together exceed
// `retainBytes` the oldest are deleted; a reader asking for an offset that is
// gone is told so (a gap) and continues from the oldest one kept.
//
// Writes are synchronous on purpose: a record is on disk before any
// subscriber sees it, and a subscriber that catches up from disk and then
// switches to live delivery can do the switch in the same tick it checks the
// end offset, with no append able to slip in between.
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RETAIN_BYTES = 64 * 1024 * 1024;

const SEGMENT_NAME = /^(\d{16})-(\d+)\.jsonl$/;
const RECORD_PREFIX = /^\{"seq":(\d+),"off":(\d+),/;

export interface EventLogOptions {
  readonly segmentBytes?: number;
  readonly retainBytes?: number;
  readonly now?: () => number;
}

/** A record as written, plus where the next one starts. `line` has no
 * trailing newline. */
export interface RawRecord {
  readonly line: string;
  readonly seq: number;
  readonly off: number;
  readonly next: number;
}

export interface AppendedRecord extends RawRecord {
  readonly t: number;
  readonly ev: Record<string, unknown>;
}

interface Segment {
  readonly base: number;
  readonly baseSeq: number;
  readonly path: string;
}

function segmentName(base: number, baseSeq: number): string {
  return `${String(base).padStart(16, "0")}-${baseSeq}.jsonl`;
}

function listSegments(dir: string): Segment[] {
  const segments: Segment[] = [];
  for (const name of readdirSync(dir)) {
    const match = SEGMENT_NAME.exec(name);
    if (match) segments.push({ base: Number(match[1]), baseSeq: Number(match[2]), path: join(dir, name) });
  }
  return segments.sort((a, b) => a.base - b.base);
}

/** Last complete line of an open file of `size` bytes, read backwards in
 * chunks (a single record can be megabytes: a large tool result). Returns
 * the byte length of the valid prefix too, so a torn final write (the host
 * died mid-`write`) can be cut off. */
function readTail(fd: number, size: number): { lastLine: string | undefined; validLength: number } {
  if (size === 0) return { lastLine: undefined, validLength: 0 };
  const chunk = 64 * 1024;
  // The file must end in "\n" to be whole; otherwise find the last "\n" and
  // treat everything after it as a torn write.
  const lastByte = Buffer.alloc(1);
  readSync(fd, lastByte, 0, 1, size - 1);
  let validLength = size;
  const findLastNewline = (before: number): number => {
    let pos = before;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.alloc(pos - start);
      readSync(fd, buf, 0, buf.length, start);
      const index = buf.lastIndexOf(0x0a);
      if (index >= 0) return start + index;
      pos = start;
    }
    return -1;
  };
  if (lastByte[0] !== 0x0a) {
    const nl = findLastNewline(size);
    validLength = nl + 1;
    if (validLength === 0) return { lastLine: undefined, validLength: 0 };
  }
  const end = validLength - 1; // position of the final "\n"
  const previous = findLastNewline(end);
  const start = previous + 1;
  const buf = Buffer.alloc(end - start);
  readSync(fd, buf, 0, buf.length, start);
  return { lastLine: buf.toString("utf8"), validLength };
}

export class AgentEventLog {
  private segments: Segment[];
  private fd: number;
  private activeSize: number;
  private _nextSeq: number;
  private readonly listeners = new Set<(record: AppendedRecord) => void>();
  private readonly segmentBytes: number;
  private readonly retainBytes: number;
  private readonly now: () => number;
  private closed = false;
  /** Compactions run one at a time, in the order segments were sealed. */
  private maintenance: Promise<void> = Promise.resolve();

  private constructor(
    readonly dir: string,
    options: EventLogOptions,
  ) {
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    this.retainBytes = options.retainBytes ?? DEFAULT_RETAIN_BYTES;
    this.now = options.now ?? Date.now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.segments = listSegments(dir);
    if (this.segments.length === 0) {
      const first = { base: 0, baseSeq: 0, path: join(dir, segmentName(0, 0)) };
      closeSync(openSync(first.path, "a", 0o600));
      this.segments.push(first);
    }
    const active = this.activeSegment;
    this.fd = openSync(active.path, "r+");
    const size = fstatSync(this.fd).size;
    const { lastLine, validLength } = readTail(this.fd, size);
    if (validLength !== size) ftruncateSync(this.fd, validLength);
    closeSync(this.fd);
    this.fd = openSync(active.path, "a", 0o600);
    this.activeSize = validLength;
    const lastSeq = lastLine ? RECORD_PREFIX.exec(lastLine) : null;
    this._nextSeq = lastSeq ? Number(lastSeq[1]) + 1 : active.baseSeq;
  }

  /** Opens (creating if needed) the log in `dir`. Synchronous: the host
   * opens a log before it accepts any operation on that agent. */
  static open(dir: string, options: EventLogOptions = {}): AgentEventLog {
    return new AgentEventLog(dir, options);
  }

  private get activeSegment(): Segment {
    return this.segments[this.segments.length - 1];
  }

  /** Offset the next record will get. */
  get endOffset(): number {
    return this.activeSegment.base + this.activeSize;
  }

  get nextSeq(): number {
    return this._nextSeq;
  }

  /** Oldest offset still readable. */
  get firstOffset(): number {
    return this.segments[0].base;
  }

  /** Segment list as of now, oldest first. */
  segmentList(): readonly Segment[] {
    return this.segments;
  }

  isActive(segment: Segment): boolean {
    return segment === this.activeSegment;
  }

  /** Appends one event and notifies listeners synchronously, after the
   * record is written. */
  append(ev: Record<string, unknown>): AppendedRecord {
    if (this.closed) throw new Error("event log is closed");
    const seq = this._nextSeq;
    const off = this.endOffset;
    const t = this.now();
    const line = JSON.stringify({ seq, off, t, ev });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    writeSync(this.fd, bytes);
    this.activeSize += bytes.length;
    this._nextSeq = seq + 1;
    const record: AppendedRecord = { line, seq, off, next: off + bytes.length, t, ev };
    for (const listener of this.listeners) listener(record);
    if (this.activeSize >= this.segmentBytes) this.rotate();
    return record;
  }

  onAppend(listener: (record: AppendedRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private rotate(): void {
    const sealed = this.activeSegment;
    closeSync(this.fd);
    const next: Segment = { base: this.endOffset, baseSeq: this._nextSeq, path: join(this.dir, segmentName(this.endOffset, this._nextSeq)) };
    this.fd = openSync(next.path, "a", 0o600);
    this.segments = [...this.segments, next];
    this.activeSize = 0;
    this.maintenance = this.maintenance.then(() => this.compact(sealed)).then(() => this.enforceRetention());
  }

  /** Drops partial-message lines from a sealed segment. Lines are kept byte
   * for byte, so their `off` stays true. Atomic (temp file + rename): a
   * reader holding the old file keeps reading the old file. */
  private async compact(segment: Segment): Promise<void> {
    try {
      const text = await readFile(segment.path, "utf8");
      const kept: string[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        if (isPartialMessage(line)) continue;
        kept.push(line);
      }
      const tmp = `${segment.path}.compact`;
      await writeFile(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
      await rename(tmp, segment.path);
    } catch (error) {
      // The segment may have been deleted by retention or by removing the
      // agent meanwhile; an uncompacted segment is still a correct one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[agent-host] log compaction failed:", (error as Error).message);
      }
    }
  }

  private enforceRetention(): Promise<void> {
    let total = 0;
    const sizes = this.segments.map((segment) => {
      try {
        return statSync(segment.path).size;
      } catch {
        return 0;
      }
    });
    for (const size of sizes) total += size;
    let dropped = 0;
    while (total > this.retainBytes && this.segments.length - dropped > 1) {
      total -= sizes[dropped];
      rmSync(this.segments[dropped].path, { force: true });
      dropped++;
    }
    if (dropped > 0) this.segments = this.segments.slice(dropped);
    return Promise.resolve();
  }

  /** Waits for pending compaction/retention work (tests, and before removal). */
  async settle(): Promise<void> {
    await this.maintenance;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    closeSync(this.fd);
  }

  /** Closes the log and deletes it from disk. */
  async destroy(): Promise<void> {
    this.close();
    await this.maintenance;
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** `stream_event` is the CLI's partial-message delta (`--include-partial-messages`). */
function isPartialMessage(line: string): boolean {
  const evIndex = line.indexOf(',"ev":');
  if (evIndex < 0) return false;
  return line.startsWith('{"type":"stream_event"', evIndex + 6);
}

export type ReadStep =
  | { readonly kind: "records"; readonly records: readonly RawRecord[] }
  | { readonly kind: "gap"; readonly requestedOffset: number; readonly resumeOffset: number; readonly reason: "truncated" | "ahead" }
  /** Nothing more on disk right now: the cursor equals the log's end as of
   * the read. The caller compares `cursor` with `endOffset` again,
   * synchronously, before switching to live delivery. */
  | { readonly kind: "end" };

/**
 * Reads an agent's log from disk in bounded steps, starting at a logical
 * offset. Holds at most one segment open. Each `step()` returns at most
 * about `maxBytes` of records, so replaying a large log neither blocks the
 * event loop nor buffers the whole log in memory.
 */
export class LogReader {
  private handle: FileHandle | undefined;
  private segment: Segment | undefined;
  private position = 0;
  private pending: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly log: AgentEventLog,
    private cursorValue: number,
  ) {}

  get cursor(): number {
    return this.cursorValue;
  }

  async step(maxBytes = 256 * 1024): Promise<ReadStep> {
    if (this.closed) return { kind: "end" };
    if (!this.segment) {
      const opened = await this.openSegmentFor(this.cursorValue);
      if (opened) return opened;
    }
    const records: RawRecord[] = [];
    let collected = 0;
    while (collected < maxBytes) {
      const handle = this.handle;
      if (!handle) break;
      const buf = Buffer.alloc(Math.min(64 * 1024, Math.max(4096, maxBytes)));
      const { bytesRead } = await handle.read(buf, 0, buf.length, this.position);
      if (this.closed) return { kind: "end" };
      if (bytesRead === 0) {
        // End of this file. A newer segment means this one is sealed and
        // fully read; move on. Otherwise this is the live end.
        const segments = this.log.segmentList();
        const current = this.segment;
        const following = current ? segments.find((segment) => segment.base > current.base) : undefined;
        if (!following) break;
        await this.closeHandle();
        this.cursorValue = Math.max(this.cursorValue, following.base);
        const opened = await this.openSegmentFor(this.cursorValue);
        if (opened) return records.length > 0 ? { kind: "records", records } : opened;
        continue;
      }
      this.position += bytesRead;
      let data = this.pending.length > 0 ? Buffer.concat([this.pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl < 0) break;
        const lineBytes = nl - start + 1;
        const line = data.toString("utf8", start, nl);
        start = nl + 1;
        const match = RECORD_PREFIX.exec(line);
        if (!match) continue;
        const off = Number(match[2]);
        if (off < this.cursorValue) continue;
        const record = { line, seq: Number(match[1]), off, next: off + lineBytes };
        records.push(record);
        this.cursorValue = record.next;
        collected += lineBytes;
      }
      data = data.subarray(start);
      this.pending = Buffer.from(data);
    }
    return records.length > 0 ? { kind: "records", records } : { kind: "end" };
  }

  /** Positions the reader on the segment holding `offset`. Returns a gap
   * step when the offset is no longer (or not yet) in the log. */
  private async openSegmentFor(offset: number): Promise<ReadStep | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const segments = this.log.segmentList();
      const first = segments[0];
      if (offset < first.base) {
        this.cursorValue = first.base;
        return { kind: "gap", requestedOffset: offset, resumeOffset: first.base, reason: "truncated" };
      }
      if (offset > this.log.endOffset) {
        const end = this.log.endOffset;
        this.cursorValue = end;
        return { kind: "gap", requestedOffset: offset, resumeOffset: end, reason: "ahead" };
      }
      let target = first;
      for (const segment of segments) if (segment.base <= offset) target = segment;
      try {
        this.handle = await open(target.path, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // retention raced us
        throw error;
      }
      this.segment = target;
      this.pending = Buffer.alloc(0);
      // The active segment is never compacted, so its physical and logical
      // positions agree and we can seek. A sealed one may have been, so it is
      // scanned from its start, skipping records below the cursor.
      this.position = this.log.isActive(target) ? offset - target.base : 0;
      return undefined;
    }
    throw new Error("event log segments kept disappearing while opening a reader");
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.segment = undefined;
    this.pending = Buffer.alloc(0);
    if (handle) await handle.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeHandle();
  }
}
