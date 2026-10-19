import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findEditTarget } from "../src/session/historyPaging.js";
import type { BroadcastMessage } from "../src/session/sharedSession.js";
import { forkTruncatedTranscript } from "../src/runtimes/defs/claude/transcriptFork.js";
import { markSilent } from "../src/protocol/silentEvents.js";

// Message editing after a silenced background-job report. Real files, no
// server: `findEditTarget` (in-memory history) and `forkTruncatedTranscript`
// (on-disk transcript) must agree on how many turns precede the edited
// message — the silenced turn stays in `history` as a marked pair for that.

function withTranscript(rawLines: unknown[], run: (path: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "anywh-history-paging-test-"));
  try {
    const path = join(home, "projects", "s-silent.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rawLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    run(path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function userLine(text: string): Record<string, unknown> {
  return { type: "user", message: { content: text }, sessionId: "old" };
}
function assistantLine(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, sessionId: "old" };
}
function turn(user: string, answer: string): BroadcastMessage[] {
  return [
    { type: "agent_event", event: { type: "user_message", text: user } },
    { type: "agent_event", event: { type: "text", text: answer } },
    { type: "agent_event", event: { type: "turn_ended", stopped: false } },
  ];
}

test("editing a message after a silenced background-job turn cuts the transcript at the right line", () => {
  // The silenced report turn stays in `history` as a marked minimal pair, so
  // the in-memory turn count still equals the transcript's `user` lines.
  const silentPair: BroadcastMessage[] = [
    { type: "agent_event", event: markSilent({ type: "user_message", text: "[anywh-bg] job done", synthetic: "background_job", label: "dev server" }) },
    { type: "agent_event", event: markSilent({ type: "turn_ended", stopped: false }) },
  ];
  const history: BroadcastMessage[] = [...turn("first", "a1"), ...silentPair, ...turn("second", "a2"), ...turn("third", "a3")];

  withTranscript(
    [
      userLine("first"),
      assistantLine("a1"),
      userLine("[anywh-bg] job done"),
      assistantLine("NO_REPLY"),
      userLine("second"),
      assistantLine("a2"),
      userLine("third"),
      assistantLine("a3"),
    ],
    (path) => {
      // The client counts only bubbles it can see: "third" is 1 from the end,
      // "second" is 2 (the silenced note is not one of them).
      const target = findEditTarget(history, 2);
      assert.ok(target);
      assert.equal(target.turnsBefore, 2, "first + the silenced turn precede 'second'");
      assert.equal(history[target.cutIndex]?.event.type, "user_message");
      assert.equal((history[target.cutIndex]?.event as { text?: string }).text, "second");

      const newId = forkTruncatedTranscript(path, target.turnsBefore);
      const kept = readLines(join(dirname(path), `${newId}.jsonl`));
      assert.equal(kept.length, 4, "first, a1, the report prompt and NO_REPLY survive; second onward is cut");
      assert.equal(JSON.stringify(kept.at(-1)).includes("NO_REPLY"), true);
    },
  );
});
