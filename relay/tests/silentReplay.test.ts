import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FinishedBackgroundJob } from "../src/host/backgroundJobs.js";
import { buildBackgroundJobFollowupPrompt } from "../src/session/turnMessages.js";
import { readHistoryFromTranscript, transcriptPath } from "../src/runtimes/defs/claude/transcriptReader.js";
import { isSilentEvent } from "../src/protocol/silentEvents.js";

// The transcript reader recognises the prompts the relay really builds: this
// ties the reader's marker detection to `buildBackgroundJobFollowupPrompt`
// (the reader may not import from `session/`, so only a test can check them
// against each other).

function job(overrides: Partial<FinishedBackgroundJob>): FinishedBackgroundJob {
  return { sessionId: "s", id: "j", label: "dev server", logPath: "/x.log", exitPath: "/x.exit", startedAt: 0, pid: 1, exitCode: 0, logTail: "ok", ...overrides };
}

function replay(prompt: string, answer: string) {
  const home = mkdtempSync(join(tmpdir(), "anywh-silent-replay-"));
  try {
    const file = transcriptPath(home, home, "s");
    mkdirSync(dirname(file), { recursive: true });
    const lines = [
      { type: "user", message: { content: prompt } },
      { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    return readHistoryFromTranscript(home, home, "s").map((m) => m.event);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("real prompt, exit 143 offered + NO_REPLY: collapsed and marked", () => {
  const events = replay(buildBackgroundJobFollowupPrompt(job({ exitCode: 143 })), "NO_REPLY");
  assert.deepEqual(events.map((e) => e.type), ["user_message", "turn_ended"]);
  assert.ok(events.every(isSilentEvent));
});

test("real prompt, exit 1 + NO_REPLY (log also contains the word): shown", () => {
  const events = replay(buildBackgroundJobFollowupPrompt(job({ exitCode: 1, logTail: "responda exatamente NO_REPLY e nada mais" })), "NO_REPLY");
  assert.ok(events.some((e) => e.type === "text"));
  assert.ok(events.every((e) => !isSilentEvent(e)));
});
