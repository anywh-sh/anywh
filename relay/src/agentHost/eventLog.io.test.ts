import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventLog, LogReader, type RawRecord } from "./eventLog.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "anywh-eventlog-"));
}

async function readAll(log: AgentEventLog, from: number, maxBytes?: number): Promise<{ records: RawRecord[]; gaps: number[] }> {
  const reader = new LogReader(log, from);
  const records: RawRecord[] = [];
  const gaps: number[] = [];
  for (;;) {
    const step = await reader.step(maxBytes);
    if (step.kind === "end") break;
    if (step.kind === "gap") gaps.push(step.resumeOffset);
    else records.push(...step.records);
  }
  await reader.close();
  return { records, gaps };
}

test("a reopened log continues seq and offset where it stopped, and drops a torn final line", () => {
  const dir = tempDir();
  try {
    const log = AgentEventLog.open(dir);
    const a = log.append({ type: "a" });
    const b = log.append({ type: "b" });
    assert.equal(a.seq, 0);
    assert.equal(a.off, 0);
    assert.equal(b.off, a.next);
    log.close();

    // A host killed in the middle of a write leaves half a line behind.
    const [segment] = readdirSync(dir);
    appendFileSync(join(dir, segment), '{"seq":2,"off":');

    const reopened = AgentEventLog.open(dir);
    assert.equal(reopened.nextSeq, 2);
    assert.equal(reopened.endOffset, b.next);
    const c = reopened.append({ type: "c" });
    assert.equal(c.seq, 2);
    assert.equal(c.off, b.next);
    reopened.close();
    const lines = readFileSync(join(dir, segment), "utf8").trimEnd().split("\n");
    assert.deepEqual(
      lines.map((line) => (JSON.parse(line) as { seq: number }).seq),
      [0, 1, 2],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sealed segment is compacted without moving any offset a reader can resume from", async () => {
  const dir = tempDir();
  try {
    const log = AgentEventLog.open(dir, { segmentBytes: 2000 });
    const written = [];
    for (let i = 0; i < 40; i++) {
      // Partial-message deltas interleaved with whole events, as the CLI
      // prints them with --include-partial-messages.
      written.push(log.append(i % 2 === 0 ? { type: "stream_event", event: { delta: "x".repeat(20) } } : { type: "assistant", n: i }));
    }
    await log.settle();
    assert.ok(log.segmentList().length > 1, "expected the log to have rotated");

    // Everything, from the start: partial messages from sealed segments are
    // gone, everything else is there in order with its original offset.
    const { records } = await readAll(log, 0);
    const activeBase = log.segmentList().at(-1)!.base;
    const expected = written.filter((record) => record.ev.type !== "stream_event" || record.off >= activeBase);
    assert.deepEqual(
      records.map((record) => [record.seq, record.off, record.next]),
      expected.map((record) => [record.seq, record.off, record.next]),
    );

    // Resuming from the `next` of a record inside a compacted segment yields
    // exactly the records after it.
    const middle = written[9];
    assert.ok(middle.off < log.segmentList()[1].base, "expected the record to sit in the first, sealed segment");
    const resumed = await readAll(log, middle.next);
    assert.deepEqual(
      resumed.records.map((record) => record.seq),
      expected.filter((record) => record.off >= middle.next).map((record) => record.seq),
    );
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention drops the oldest segments and a reader behind them is told about the gap", async () => {
  const dir = tempDir();
  try {
    const log = AgentEventLog.open(dir, { segmentBytes: 1000, retainBytes: 3000 });
    for (let i = 0; i < 100; i++) log.append({ type: "assistant", text: "y".repeat(40), i });
    await log.settle();
    assert.ok(log.firstOffset > 0, "expected old segments to be dropped");
    const { records, gaps } = await readAll(log, 0);
    assert.deepEqual(gaps, [log.firstOffset]);
    assert.equal(records[0].off, log.firstOffset);
    assert.equal(records.at(-1)!.next, log.endOffset);
    // seq stays contiguous over what is kept.
    for (let i = 1; i < records.length; i++) assert.equal(records[i].seq, records[i - 1].seq + 1);
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader returns a large log in bounded steps, every record exactly once", async () => {
  const dir = tempDir();
  try {
    const log = AgentEventLog.open(dir, { segmentBytes: 64 * 1024 });
    for (let i = 0; i < 3000; i++) log.append({ type: "user", i, pad: "z".repeat(i % 50) });
    await log.settle();
    const reader = new LogReader(log, 0);
    const seqs: number[] = [];
    let steps = 0;
    for (;;) {
      const step = await reader.step(8 * 1024);
      if (step.kind === "end") break;
      assert.equal(step.kind, "records");
      if (step.kind !== "records") break;
      steps++;
      const bytes = step.records.reduce((sum, record) => sum + (record.next - record.off), 0);
      // One step may overshoot by one read buffer (sized to the step) plus
      // the partial line carried over from the previous read.
      assert.ok(bytes <= 2 * 8 * 1024 + 512, `step of ${bytes} bytes`);
      seqs.push(...step.records.map((record) => record.seq));
    }
    await reader.close();
    assert.ok(steps > 5, `expected many steps, got ${steps}`);
    assert.deepEqual(
      seqs,
      Array.from({ length: 3000 }, (_, i) => i),
    );
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an offset past the end is reported as a gap and the reader continues from the end", async () => {
  const dir = tempDir();
  try {
    const log = AgentEventLog.open(dir);
    log.append({ type: "a" });
    const { records, gaps } = await readAll(log, log.endOffset + 500);
    assert.deepEqual(gaps, [log.endOffset]);
    assert.deepEqual(records, []);
    log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
