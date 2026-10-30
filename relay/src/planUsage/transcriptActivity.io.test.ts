import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasClaudeActivitySince } from "./transcriptActivity.js";

test("transcript activity: any .jsonl under projects/ written after the instant, up to subagent depth", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-transcripts-"));
  const project = join(home, ".claude", "projects", "-home-someone-repo");
  const nested = join(project, "abc", "subagents");
  mkdirSync(nested, { recursive: true });
  const old = join(project, "a.jsonl");
  writeFileSync(old, "");
  utimesSync(old, 1000, 1000);
  writeFileSync(join(project, "notes.txt"), "");
  assert.equal(await hasClaudeActivitySince(home, 2_000_000, {}), false);

  const sub = join(nested, "agent.jsonl");
  writeFileSync(sub, "");
  utimesSync(sub, 3000, 3000);
  assert.equal(await hasClaudeActivitySince(home, 2_000_000, {}), true);
  assert.equal(await hasClaudeActivitySince(home, 3_000_000, {}), false);

  // CLAUDE_CONFIG_DIR replaces ~/.claude; a missing dir is no activity.
  assert.equal(await hasClaudeActivitySince(home, 0, { CLAUDE_CONFIG_DIR: join(home, "elsewhere") }), false);
  assert.equal(await hasClaudeActivitySince(home, 0, { CLAUDE_CONFIG_DIR: join(home, ".claude") }), true);
});
