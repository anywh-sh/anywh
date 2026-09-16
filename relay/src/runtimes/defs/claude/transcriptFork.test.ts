import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transcriptPath } from "./transcriptReader.js";
import { forkTruncatedTranscript } from "./transcriptFork.js";

function withFixture(sessionId: string, rawLines: unknown[], run: (home: string, path: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "anywh-transcript-fork-test-"));
  try {
    const path = transcriptPath(home, home, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rawLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    run(home, path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("keeps only the lines before the cut turn, with a new sessionId in each one", () => {
  withFixture(
    "s1",
    [
      { type: "user", sessionId: "s1", uuid: "u1", message: { content: "question 1" } },
      { type: "assistant", sessionId: "s1", uuid: "a1", message: { content: [{ type: "text", text: "answer 1" }] } },
      { type: "user", sessionId: "s1", uuid: "u2", message: { content: "question 2 (edited)" } },
      { type: "assistant", sessionId: "s1", uuid: "a2", message: { content: [{ type: "text", text: "answer 2" }] } },
    ],
    (_home, path) => {
      const newSessionId = forkTruncatedTranscript(path, 1);
      const newPath = join(dirname(path), `${newSessionId}.jsonl`);
      assert.ok(existsSync(newPath));

      const kept = readLines(newPath);
      assert.equal(kept.length, 2);
      assert.equal(kept[0].uuid, "u1");
      assert.equal(kept[1].uuid, "a1");
      assert.ok(kept.every((line) => line.sessionId === newSessionId));
      assert.notEqual(newSessionId, "s1");

      // Original file untouched — the cut never modifies it.
      assert.equal(readLines(path).length, 4);
    },
  );
});

test("turnsToKeep 0: new file ends up empty (equivalent to /clear, but the caller should prefer resetSessionId in this case)", () => {
  withFixture(
    "s1",
    [
      { type: "user", sessionId: "s1", uuid: "u1", message: { content: "first message" } },
      { type: "assistant", sessionId: "s1", uuid: "a1", message: { content: [{ type: "text", text: "answer" }] } },
    ],
    (_home, path) => {
      const newSessionId = forkTruncatedTranscript(path, 0);
      const newPath = join(dirname(path), `${newSessionId}.jsonl`);
      assert.equal(readFileSync(newPath, "utf8"), "");
    },
  );
});

test("lines that aren't genuine human text (tool_result) don't count as a turn", () => {
  withFixture(
    "s1",
    [
      { type: "user", sessionId: "s1", uuid: "u1", message: { content: "question 1" } },
      { type: "assistant", sessionId: "s1", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
      { type: "user", sessionId: "s1", uuid: "u1b", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "assistant", sessionId: "s1", uuid: "a1b", message: { content: [{ type: "text", text: "done" }] } },
      { type: "user", sessionId: "s1", uuid: "u2", message: { content: "question 2" } },
    ],
    (_home, path) => {
      // Cutting while keeping 1 turn should preserve the first 4 lines (the
      // whole turn, including the tool_result in the middle), not stop at u1b.
      const newSessionId = forkTruncatedTranscript(path, 1);
      const kept = readLines(join(dirname(path), `${newSessionId}.jsonl`));
      assert.deepEqual(
        kept.map((line) => line.uuid),
        ["u1", "a1", "u1b", "a1b"],
      );
    },
  );
});
