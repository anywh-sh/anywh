import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHistoryFromTranscript, transcriptPath } from "./transcriptReader.js";

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

test("simple text -> text turn, no synthetic turn_complete at the end of the file", () => {
  withFixture(
    "s1",
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } }),
    ],
    (home) => {
      const result = readHistoryFromTranscript(home, home, "s1");
      assert.deepEqual(result, [
        { type: "claude_event", event: { type: "user_prompt", message: { content: [{ type: "text", text: "hi" }] } } },
        { type: "claude_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } } },
      ]);
    },
  );
});

test("second turn closes the first with a synthetic turn_complete, tool_use/tool_result pass through", () => {
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
      const shape = result.map((m) => (m.type === "claude_event" ? `claude_event:${m.event.type}` : m.type));
      assert.deepEqual(shape, [
        "claude_event:user_prompt",
        "claude_event:assistant",
        "turn_complete",
        "claude_event:user_prompt",
        "claude_event:assistant",
        "claude_event:user",
        "claude_event:assistant",
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
    assert.deepEqual(result, [
      { type: "claude_event", event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } },
    ]);
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
        { type: "claude_event", event: { type: "user_prompt", message: { content: [{ type: "text", text: "do something" }] } } },
        { type: "claude_event", event: { type: "assistant", message: { content: [{ type: "text", text: "done" }] } } },
      ]);
    },
  );
});
