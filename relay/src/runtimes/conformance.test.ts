import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, ToolOutcome, ToolSubject } from "../protocol/agent-event.js";
import type { ClaudeEvent } from "./defs/claude/index.js";
import { mapClaudeEvent } from "./streams/claudeStreamJson.js";
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
