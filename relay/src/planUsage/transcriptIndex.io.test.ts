import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptIndex, transcriptActivitySince } from "./transcriptIndex.js";
import { createTranscriptLimitReader } from "./transcriptLimits.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MIN = 60_000;
const at = (path: string, ms: number) => utimesSync(path, ms / 1000, ms / 1000);

/** `projects` with `projectCount` projects of `filesEach` old transcripts. */
function tree(projectCount: number, filesEach: number): { root: string; projects: string[] } {
  const root = join(mkdtempSync(join(tmpdir(), "anywh-transcript-index-")), "projects");
  const projects: string[] = [];
  for (let p = 0; p < projectCount; p++) {
    const project = join(root, `-home-someone-repo-${p}`);
    mkdirSync(project, { recursive: true });
    for (let f = 0; f < filesEach; f++) {
      const file = join(project, `s${f}.jsonl`);
      writeFileSync(file, "{}\n");
      at(file, NOW - 3 * 24 * 60 * MIN - (p * filesEach + f) * MIN);
    }
    at(project, NOW - 3 * 24 * 60 * MIN);
    projects.push(project);
  }
  at(root, NOW - 3 * 24 * 60 * MIN);
  return { root, projects };
}

function clock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("a refresh inside the floor costs nothing; one past it stats only the dirs and the hot files", async () => {
  const { root } = tree(10, 30);
  const time = clock();
  const index = new TranscriptIndex({ root, now: time.now, hotFiles: 5 });
  assert.equal((await index.list()).length, 300);
  const full = index.operations;
  assert.ok(full >= 300);

  await index.list();
  assert.equal(index.operations, full);

  time.advance(MIN);
  await index.list();
  // root + 10 project dirs + 5 hot files.
  assert.equal(index.operations - full, 16);
});

test("an append to a recent transcript and a new session file are seen at the next refresh", async () => {
  const { root, projects } = tree(3, 4);
  const time = clock();
  const index = new TranscriptIndex({ root, now: time.now, hotFiles: 2 });
  await index.list();
  const project = projects[0];
  const hot = join(project, "s0.jsonl");
  assert.equal(await transcriptActivitySince(index, NOW - MIN), false);

  time.advance(MIN);
  appendFileSync(hot, "{}\n");
  at(hot, time.now());
  assert.equal(await transcriptActivitySince(index, NOW), true);

  time.advance(MIN);
  const fresh = join(projects[2], "new-session.jsonl");
  writeFileSync(fresh, "{}\n");
  at(fresh, time.now());
  at(projects[2], time.now());
  const listed = await index.list();
  assert.equal(listed[0]?.path, fresh);
});

test("an old transcript resumed out of the hot set waits for the full rescan", async () => {
  const { root, projects } = tree(2, 10);
  const time = clock();
  const index = new TranscriptIndex({ root, now: time.now, hotFiles: 2, fullRescanMs: 5 * MIN });
  await index.list();
  const cold = join(projects[1], "s9.jsonl");
  time.advance(MIN);
  appendFileSync(cold, "{}\n");
  at(cold, time.now());
  assert.equal(await transcriptActivitySince(index, NOW), false);
  time.advance(4 * MIN);
  assert.equal(await transcriptActivitySince(index, NOW), true);
});

test("limit reader: a transcript is read again only when its mtime or size changed", async () => {
  const { root, projects } = tree(1, 3);
  const time = clock();
  const index = new TranscriptIndex({ root, now: time.now });
  const reader = createTranscriptLimitReader(index, { maxFiles: 5 });
  const file = join(projects[0], "s0.jsonl");
  at(file, NOW - MIN);
  assert.equal(await reader.read(NOW), undefined);
  const first = reader.tailsRead;
  assert.equal(first, 3);

  time.advance(MIN);
  assert.equal(await reader.read(time.now()), undefined);
  assert.equal(reader.tailsRead, first);

  time.advance(MIN);
  const refusal = {
    type: "assistant",
    timestamp: new Date(time.now()).toISOString(),
    apiError: "usage_limit_reached",
    apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: Math.floor((time.now() + 60 * MIN) / 1000), rateLimitType: "five_hour" } },
  };
  appendFileSync(file, `${JSON.stringify(refusal)}\n`);
  at(file, time.now());
  assert.equal((await reader.read(time.now()))?.window.usedPercent, 100);
  assert.equal(reader.tailsRead, first + 1);
});
