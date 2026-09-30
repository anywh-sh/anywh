import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, ToolOutcome, ToolSubject } from "../protocol/agent-event.js";
import type { ClaudeEvent } from "./defs/claude/index.js";
import { mapClaudeEvent } from "./streams/claudeStreamJson.js";
import { mapCodexNotification } from "./streams/codexAppServer.js";
import type { ToolCallMemo } from "./streams/claudeToolMapping.js";

/**
 * The gate a runtime passes to display tool calls: give it the events a real
 * turn of that runtime's CLI produced, mapped through its mapper, and it
 * checks that the result fulfils the contract a UI relies on — every call is
 * identified and interpreted, every result pairs with a call, and what a
 * result claims to be fits what the call said it was doing.
 */
const OUTCOMES_FOR: Record<ToolSubject["kind"], ToolOutcome["kind"][]> = {
  read: ["code", "text"],
  edit: ["diff", "text"],
  write: ["diff", "text"],
  shell: ["terminal", "code", "files", "matches", "text"],
  search: ["files", "matches", "text"],
  web: ["links", "text"],
  mcp: ["payload", "text"],
  task: ["text"],
  other: ["text", "payload"],
};

const BRIDGE_TOOL = /^mcp__anywh-(choice|permission)__/;

export function assertToolContract(events: AgentEvent[]): void {
  const started = new Map<string, Extract<AgentEvent, { type: "tool_started" }>>();
  for (const event of events) {
    if (event.type === "tool_started") {
      assert.ok(event.toolUseId, `tool_started "${event.name}" has no toolUseId`);
      assert.ok(event.subject, `tool_started "${event.name}" has no subject`);
      started.set(event.toolUseId, event);
    } else if (event.type === "tool_ended") {
      assert.ok(event.toolUseId && started.has(event.toolUseId), `tool_ended ${event.toolUseId} pairs with no tool_started`);
      const call = started.get(event.toolUseId)!;
      if (event.outcome && call.subject) {
        assert.ok(
          OUTCOMES_FOR[call.subject.kind].includes(event.outcome.kind),
          `a ${call.subject.kind} call ended with a "${event.outcome.kind}" outcome`,
        );
      }
    }
  }
}

/** Raw stream-json lines as the CLI printed them — payloads for Glob/Grep
 * captured from a live run, the rest from real transcripts (paths trimmed). */
const CLAUDE_TURN: ClaudeEvent[] = [
  { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/p/a.ts" } }, { type: "tool_use", id: "gl", name: "Glob", input: { pattern: "**/*.txt" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r", content: "1\tone" }] }, tool_use_result: { type: "text", file: { filePath: "/p/a.ts", content: "one\n", startLine: 1, numLines: 1, totalLines: 1 } } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "gl", content: "a.txt" }] }, tool_use_result: { filenames: ["a.txt"], numFiles: 1, truncated: false } },
  { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "gr", name: "Grep", input: { pattern: "needle", output_mode: "content" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "gr", content: "a.txt:2:beta needle" }] }, tool_use_result: { mode: "content", filenames: [], content: "a.txt:2:beta needle", numLines: 1, totalLines: 1 } },
  { type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "ed", name: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ed", content: "ok" }] }, tool_use_result: { filePath: "/p/a.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] } },
  { type: "assistant", message: { id: "m4", content: [{ type: "tool_use", id: "bs", name: "Bash", input: { command: "false" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bs", is_error: true, content: "Exit code 1" }] }, tool_use_result: { stdout: "", stderr: "" } },
  { type: "assistant", message: { id: "m5", content: [{ type: "tool_use", id: "ws", name: "WebSearch", input: { query: "q" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ws", content: "links" }] }, tool_use_result: { query: "q", results: [{ tool_use_id: "x", content: [{ title: "T", url: "https://t.dev" }] }] } },
  { type: "assistant", message: { id: "m6", content: [{ type: "tool_use", id: "mc", name: "mcp__linear__get_issue", input: { id: "X-1" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "mc", content: "{}" }] }, tool_use_result: [{ type: "text", text: "{}" }] },
  { type: "assistant", message: { id: "m7", content: [{ type: "tool_use", id: "pc", name: "mcp__anywh-choice__present_choice", input: {} }] } },
];

test("claude: a real turn fulfils the tool display contract", () => {
  const memos = new Map<string, ToolCallMemo>();
  const events = CLAUDE_TURN.flatMap((event) => mapClaudeEvent(event, memos));
  assertToolContract(events);
});

test("claude: every outcome kind the display draws is produced by some tool", () => {
  const memos = new Map<string, ToolCallMemo>();
  const kinds = new Set(
    CLAUDE_TURN.flatMap((event) => mapClaudeEvent(event, memos)).flatMap((event) => (event.type === "tool_ended" && event.outcome ? [event.outcome.kind] : [])),
  );
  assert.deepEqual([...kinds].sort(), ["code", "diff", "files", "links", "matches", "payload", "terminal"]);
});

test("claude: the relay's own bridge is identifiable as such from the subject alone", () => {
  const events = CLAUDE_TURN.flatMap((event) => mapClaudeEvent(event));
  const bridge = events.filter((event) => event.type === "tool_started" && BRIDGE_TOOL.test(event.name));
  assert.equal(bridge.length, 1);
  assert.deepEqual(bridge[0]?.type === "tool_started" && bridge[0].subject, { kind: "mcp", server: "anywh-choice", tool: "present_choice" });
});

/** Notifications as `codex app-server` (0.154) sends them — item shapes from
 * the generated bindings, the outputs from a real run. */
const CODEX_TURN: [string, unknown][] = [
  ["item/started", { startedAtMs: 1, item: { type: "reasoning", id: "rs", summary: [], content: [] } }],
  ["item/completed", { completedAtMs: 2, item: { type: "reasoning", id: "rs", summary: ["Plan"], content: [] } }],
  ["item/started", { startedAtMs: 3, item: { type: "commandExecution", id: "rd", command: "/usr/bin/bash -lc 'sed -n 2,3p f.txt'", status: "inProgress", commandActions: [{ type: "read", command: "sed -n 2,3p f.txt", name: "f.txt", path: "/w/f.txt" }], aggregatedOutput: null, exitCode: null } }],
  ["item/completed", { completedAtMs: 4, item: { type: "commandExecution", id: "rd", command: "/usr/bin/bash -lc 'sed -n 2,3p f.txt'", status: "completed", commandActions: [{ type: "read", command: "sed -n 2,3p f.txt", name: "f.txt", path: "/w/f.txt" }], aggregatedOutput: "two\nthree\n", exitCode: 0 } }],
  ["item/started", { startedAtMs: 5, item: { type: "commandExecution", id: "sh", command: "/usr/bin/bash -lc 'npm test'", status: "inProgress", commandActions: [{ type: "unknown", command: "npm test" }], aggregatedOutput: null, exitCode: null } }],
  ["item/completed", { completedAtMs: 6, item: { type: "commandExecution", id: "sh", command: "/usr/bin/bash -lc 'npm test'", status: "failed", commandActions: [{ type: "unknown", command: "npm test" }], aggregatedOutput: "1 failing", exitCode: 1 } }],
  ["item/started", { startedAtMs: 7, item: { type: "fileChange", id: "fc", status: "inProgress", changes: [{ path: "/w/f.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-one\n+ONE\n" }, { path: "/w/g.txt", kind: { type: "add" }, diff: "hello\n" }] } }],
  ["item/completed", { completedAtMs: 8, item: { type: "fileChange", id: "fc", status: "completed", changes: [{ path: "/w/f.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-one\n+ONE\n" }, { path: "/w/g.txt", kind: { type: "add" }, diff: "hello\n" }] } }],
  ["item/started", { startedAtMs: 9, item: { type: "webSearch", id: "ws", query: "q", action: { type: "search", query: "q", queries: null }, results: null } }],
  ["item/completed", { completedAtMs: 10, item: { type: "webSearch", id: "ws", query: "q", action: { type: "search", query: "q", queries: null }, results: [{ title: "T", url: "https://t.dev" }] } }],
  ["item/started", { startedAtMs: 11, item: { type: "mcpToolCall", id: "mc", server: "linear", tool: "get_issue", status: "inProgress", arguments: { id: "X-1" }, result: null, error: null } }],
  ["item/completed", { completedAtMs: 12, item: { type: "mcpToolCall", id: "mc", server: "linear", tool: "get_issue", status: "completed", arguments: { id: "X-1" }, result: { content: [] }, error: null } }],
  ["item/started", { startedAtMs: 13, item: { type: "mcpToolCall", id: "pc", server: "anywh-choice", tool: "present_choice", status: "inProgress", arguments: {}, result: null, error: null } }],
];

test("codex: a real turn fulfils the tool display contract", () => {
  assertToolContract(CODEX_TURN.flatMap(([method, params]) => mapCodexNotification(method, params)));
});

test("codex: shell-run reads and edits reach the display as reads and diffs, and every timed call carries the daemon's own times", () => {
  const events = CODEX_TURN.flatMap(([method, params]) => mapCodexNotification(method, params));
  const outcomes = new Set(events.flatMap((event) => (event.type === "tool_ended" && event.outcome ? [event.outcome.kind] : [])));
  assert.deepEqual([...outcomes].sort(), ["code", "diff", "links", "payload", "terminal"]);
  for (const event of events) {
    if (event.type === "tool_started") assert.equal(typeof event.startedAt, "number");
    if (event.type === "tool_ended") assert.equal(typeof event.endedAt, "number");
  }
});

test("codex: the relay's own bridge is identifiable as such from the subject alone", () => {
  const events = CODEX_TURN.flatMap(([method, params]) => mapCodexNotification(method, params));
  const bridge = events.filter((event) => event.type === "tool_started" && event.subject?.kind === "mcp" && event.subject.server === "anywh-choice");
  assert.equal(bridge.length, 1);
});
