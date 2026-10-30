import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeTranscriptLimit } from "./transcriptLimits.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const MIN = 60_000;

function refusal(at: number, resetsAt: number, rateLimitType = "five_hour"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    apiError: "usage_limit_reached",
    apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: Math.floor(resetsAt / 1000), rateLimitType } },
  });
}
const chatter = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", message: { content: `line ${i}` } })).join("\n");

function project(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "anywh-transcript-limits-"));
  const dir = join(home, ".claude", "projects", "-home-someone-repo");
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

function write(path: string, text: string, mtime: number): void {
  writeFileSync(path, text);
  utimesSync(path, mtime / 1000, mtime / 1000);
}

test("the latest refusal of the recent transcripts, while its window runs", async () => {
  const { home, dir } = project();
  write(join(dir, "a.jsonl"), `${chatter(3)}\n${refusal(NOW - 30 * MIN, NOW + 40 * MIN)}\n${chatter(2)}\n`, NOW - 25 * MIN);
  write(join(dir, "b.jsonl"), `${chatter(5)}\n`, NOW - MIN);
  const limit = await readClaudeTranscriptLimit(home, NOW, { env: {} });
  assert.deepEqual(limit, { window: { durationMins: 300, usedPercent: 100, resetsAt: Math.floor((NOW + 40 * MIN) / 1000) * 1000 }, observedAt: NOW - 30 * MIN });

  // A later refusal elsewhere wins.
  const nested = join(dir, "session", "subagents");
  mkdirSync(nested, { recursive: true });
  write(join(nested, "agent.jsonl"), `${refusal(NOW - 5 * MIN, NOW + 3 * 24 * 60 * MIN, "seven_day")}\n`, NOW - 5 * MIN);
  assert.equal((await readClaudeTranscriptLimit(home, NOW, { env: {} }))?.window.durationMins, 10080);
});

test("an expired refusal, or none, is nothing", async () => {
  const { home, dir } = project();
  assert.equal(await readClaudeTranscriptLimit(home, NOW, { env: {} }), undefined);
  write(join(dir, "a.jsonl"), `${refusal(NOW - 6 * 60 * MIN, NOW - MIN)}\n`, NOW - 6 * 60 * MIN);
  assert.equal(await readClaudeTranscriptLimit(home, NOW, { env: {} }), undefined);
});

test("cost is bounded: only the tail, only the most recent files, nothing older than a week", async () => {
  const { home, dir } = project();
  // The refusal sits before the tail that is read.
  write(join(dir, "long.jsonl"), `${refusal(NOW - 10 * MIN, NOW + 60 * MIN)}\n${chatter(2000)}\n`, NOW - 2 * MIN);
  assert.equal(await readClaudeTranscriptLimit(home, NOW, { env: {}, tailBytes: 4096 }), undefined);

  const other = project();
  write(join(other.dir, "old.jsonl"), `${refusal(NOW - 10 * MIN, NOW + 60 * MIN)}\n`, NOW - 8 * 24 * 60 * MIN);
  assert.equal(await readClaudeTranscriptLimit(other.home, NOW, { env: {} }), undefined);

  const many = project();
  write(join(many.dir, "limit.jsonl"), `${refusal(NOW - 10 * MIN, NOW + 60 * MIN)}\n`, NOW - 10 * MIN);
  for (let i = 0; i < 3; i++) write(join(many.dir, `newer-${i}.jsonl`), `${chatter(1)}\n`, NOW - i * MIN);
  assert.equal(await readClaudeTranscriptLimit(many.home, NOW, { env: {}, maxFiles: 3 }), undefined);
  assert.notEqual(await readClaudeTranscriptLimit(many.home, NOW, { env: {}, maxFiles: 4 }), undefined);
});

test("CLAUDE_CONFIG_DIR replaces ~/.claude", async () => {
  const { home } = project();
  const config = mkdtempSync(join(tmpdir(), "anywh-claude-config-"));
  mkdirSync(join(config, "projects", "p"), { recursive: true });
  write(join(config, "projects", "p", "a.jsonl"), `${refusal(NOW - MIN, NOW + MIN * 30)}\n`, NOW - MIN);
  assert.equal(await readClaudeTranscriptLimit(home, NOW, { env: {} }), undefined);
  assert.notEqual(await readClaudeTranscriptLimit(home, NOW, { env: { CLAUDE_CONFIG_DIR: config } }), undefined);
});
