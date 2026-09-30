import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHistoryFromTranscript, transcriptPath } from "./transcriptReader.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";

function withFixture(sessionId: string, rawLines: string[], run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "anywh-transcript-test-"));
  try {
    // home == cwd in these tests — the distinction only matters for the real
    // caller (SharedSession), which resolves the two separately.
    const file = transcriptPath(home, home, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rawLines.join("\n"));
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("session without a transcript returns empty", () => {
  withFixture("does-not-exist", [], (home) => {
    assert.deepEqual(readHistoryFromTranscript(home, home, "outra-sessao"), []);
  });
});

test("simple text -> text turn, no synthetic turn_ended at the end of the file", () => {
  withFixture(
    "s1",
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } }),
    ],
    (home) => {
      const result = readHistoryFromTranscript(home, home, "s1");
      assert.deepEqual(result, [
        { type: "agent_event", event: { type: "turn_started" } },
        { type: "agent_event", event: { type: "user_message", text: "hi" } },
        { type: "agent_event", event: { type: "text", text: "hello!" } },
      ]);
    },
  );
});

test("second turn closes the first with a synthetic turn_ended, tool_use/tool_result pass through", () => {
  withFixture(
    "s2",
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } }),
      JSON.stringify({ type: "user", message: { content: "do something" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    ],
    (home) => {
      const result = readHistoryFromTranscript(home, home, "s2");
      const shape = result.map((m) => m.event.type);
      assert.deepEqual(shape, [
        "turn_started",
        "user_message",
        "text",
        "turn_ended",
        "turn_started",
        "user_message",
        "tool_started",
        "tool_ended",
        "text",
      ]);
    },
  );
});

test("cwd crossing a symlink resolves to the real path (real bug: ~/.anywh-trabalho-home/mode -> ~/mode)", () => {
  const realHome = mkdtempSync(join(tmpdir(), "anywh-transcript-test-real-"));
  const linkDir = mkdtempSync(join(tmpdir(), "anywh-transcript-test-link-"));
  const cwdLink = join(linkDir, "mode");
  try {
    symlinkSync(realHome, cwdLink);
    // Writes the transcript to the folder computed from the REAL path —
    // that's where Claude Code actually writes it (it never sees the
    // symlink component, `process.cwd()` already arrives resolved from the
    // kernel).
    const file = transcriptPath(realHome, realHome, "s-symlink");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));

    // The session's `cwd` saved by the relay is the path WITH the symlink
    // in the middle (what the user chose/what got persisted) — before the
    // fix this computed a different folder than the one written above and
    // returned [].
    const result = readHistoryFromTranscript(realHome, cwdLink, "s-symlink");
    assert.deepEqual(result, [{ type: "agent_event", event: { type: "text", text: "hi" } }]);
  } finally {
    rmSync(realHome, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test("isMeta, unknown types, and a truncated line are ignored without breaking the parse", () => {
  withFixture(
    "s3",
    [
      JSON.stringify({ type: "user", isMeta: true, message: { content: "<system-reminder>...</system-reminder>" } }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "do something" }),
      JSON.stringify({ type: "user", message: { content: "do something" } }),
      JSON.stringify({ type: "future-record-type", whatever: true }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      '{"type": "user", "message": {"content": "truncated mid',
    ],
    (home) => {
      const result = readHistoryFromTranscript(home, home, "s3");
      assert.deepEqual(result, [
        { type: "agent_event", event: { type: "turn_started" } },
        { type: "agent_event", event: { type: "user_message", text: "do something" } },
        { type: "agent_event", event: { type: "text", text: "done" } },
      ]);
    },
  );
});

// ---- replay carries the same interpretation and timing as a live turn -----

const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

test("a replayed turn gets the outcome, batch and timing a live one has", () => {
  const patch = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] };
  withFixture(
    "timed",
    [
      JSON.stringify({ type: "user", timestamp: iso(0), message: { content: "fix it" } }),
      JSON.stringify({ type: "assistant", timestamp: iso(1_000), message: { id: "m1", content: [{ type: "thinking", thinking: "" }] } }),
      JSON.stringify({
        type: "assistant",
        timestamp: iso(3_000),
        message: {
          id: "m2",
          content: [
            { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/a.ts" } },
            { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: iso(4_500),
        message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "edited" }] },
        toolUseResult: { filePath: "/a.ts", structuredPatch: [patch] },
      }),
      JSON.stringify({ type: "user", timestamp: iso(5_000), message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "x" }] }, toolUseResult: { stdout: "x", stderr: "" } }),
      JSON.stringify({ type: "assistant", timestamp: iso(6_000), message: { id: "m3", content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "user", timestamp: iso(60_000), message: { content: "next" } }),
    ],
    (home) => {
      const events = readHistoryFromTranscript(home, home, "timed").map((entry) => entry.event);
      assert.deepEqual(events[0], { type: "turn_started", startedAt: T0 });
      assert.deepEqual(events.find((e) => e.type === "thinking"), { type: "thinking", thinking: "", timestamp: iso(1_000), startedAt: T0, endedAt: T0 + 1_000 });
      const edit = events.find((e) => e.type === "tool_started" && e.toolUseId === "e1");
      assert.deepEqual(edit, {
        type: "tool_started",
        toolUseId: "e1",
        name: "Edit",
        kind: "edit",
        input: { file_path: "/a.ts" },
        subject: { kind: "edit", path: "/a.ts" },
        batchId: "m2",
        startedAt: T0 + 3_000,
      });
      const editEnd = events.find((e) => e.type === "tool_ended" && e.toolUseId === "e1");
      assert.deepEqual(editEnd, {
        type: "tool_ended",
        toolUseId: "e1",
        content: "edited",
        isError: false,
        structuredPatch: [patch],
        outcome: { kind: "diff", path: "/a.ts", hunks: [patch], added: 1, removed: 1 },
        endedAt: T0 + 4_500,
      });
      // The turn lasted from its prompt to its last line, not to the next prompt.
      assert.deepEqual(events.find((e) => e.type === "turn_ended"), { type: "turn_ended", stopped: false, durationMs: 6_000 });
    },
  );
});

test("a replayed turn produces the same subject and outcome as the live stream did", () => {
  const assistant = { type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "g", name: "Grep", input: { pattern: "needle" } }] } };
  const result = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "g", content: "a.txt:2:beta needle" }] },
    tool_use_result: { mode: "content", filenames: [], content: "a.txt:2:beta needle", numLines: 1, totalLines: 1 },
  };
  const memos = new Map();
  const live = [...mapClaudeEvent(assistant, memos), ...mapClaudeEvent(result, memos)];
  withFixture(
    "parity",
    [
      JSON.stringify({ type: "user", message: { content: "find" } }),
      JSON.stringify({ type: "assistant", message: assistant.message }),
      JSON.stringify({ type: "user", message: result.message, toolUseResult: result.tool_use_result }),
    ],
    (home) => {
      const replayed = readHistoryFromTranscript(home, home, "parity")
        .map((entry) => entry.event)
        .filter((event) => event.type === "tool_started" || event.type === "tool_ended");
      assert.deepEqual(replayed, live);
    },
  );
});
