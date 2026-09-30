import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaudeEvent } from "../defs/claude/index.js";
import { mapClaudeEvent } from "./claudeStreamJson.js";

// ---- user_prompt ----------------------------------------------------------

test("user_prompt: a real human message becomes user_message", () => {
  const event: ClaudeEvent = { type: "user_prompt", message: { content: [{ type: "text", text: "oi" }] } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "user_message", text: "oi" }]);
});

test("user_prompt: timestamp passes through when present (replay), absent when not (live)", () => {
  const withTimestamp: ClaudeEvent = {
    type: "user_prompt",
    message: { content: [{ type: "text", text: "oi" }] },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(mapClaudeEvent(withTimestamp), [{ type: "user_message", text: "oi", timestamp: "2026-01-01T00:00:00.000Z" }]);
});

test("user_prompt: synthetic background_job carries its label", () => {
  const event: ClaudeEvent = {
    type: "user_prompt",
    synthetic: "background_job",
    label: "build finished",
    message: { content: [{ type: "text", text: "..." }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [
    { type: "user_message", text: "...", synthetic: "background_job", label: "build finished" },
  ]);
});

test("user_prompt: no text block (unexpected shape) maps to nothing, doesn't throw", () => {
  const event: ClaudeEvent = { type: "user_prompt", message: { content: [] } };
  assert.deepEqual(mapClaudeEvent(event), []);
});

// ---- assistant: text / thinking -------------------------------------------

test("assistant: a text block becomes text", () => {
  const event: ClaudeEvent = { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "text", text: "hello" }]);
});

test("assistant: the synthetic interrupt marker is dropped (turn_ended.stopped already covers it)", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
  };
  assert.deepEqual(mapClaudeEvent(event), []);
});

test("assistant: a thinking block becomes thinking", () => {
  const event: ClaudeEvent = { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "thinking", thinking: "hmm" }]);
});

test("assistant: usage is extracted from a main-thread event's message.usage, prefixTokens summing all three (additive, unlike Codex's)", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 7 },
    },
  };
  assert.deepEqual(mapClaudeEvent(event), [
    { type: "usage", inputTokens: 10, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, prefixTokens: 15, outputTokens: 7 },
    { type: "text", text: "hi" },
  ]);
});

test("assistant: usage is NOT extracted from a subagent event (parent_tool_use_id set) — real finding: subagent usage starts from zero and would contaminate the main thread's number", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    parent_tool_use_id: "toolu_task",
    message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 999 } },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "text", text: "hi", parentToolUseId: "toolu_task" }]);
});

test("assistant: missing usage fields default to 0 rather than throwing", () => {
  const event: ClaudeEvent = { type: "assistant", message: { content: [], usage: {} } };
  assert.deepEqual(mapClaudeEvent(event), [
    { type: "usage", inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, prefixTokens: 0, outputTokens: 0 },
  ]);
});

// ---- assistant: tool_use ----------------------------------------------------

test("assistant: tool_use classifies known tool names into their ToolKind", () => {
  const cases: [string, string][] = [
    ["Bash", "shell"],
    ["Edit", "edit"],
    ["Write", "write"],
    ["Read", "read"],
    ["Grep", "search"],
    ["Glob", "search"],
    ["Task", "task"],
    ["MultiEdit", "edit"],
    ["WebSearch", "web"],
    ["WebFetch", "web"],
    ["mcp__linear__get", "mcp"],
  ];
  for (const [name, kind] of cases) {
    const event: ClaudeEvent = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name, input: { foo: "bar" } }] },
    };
    const [started] = mapClaudeEvent(event);
    assert.equal(started?.type === "tool_started" && started.kind, kind, name);
  }
});

test("assistant: tool_use with an unrecognized name maps to ToolKind \"other\" instead of throwing", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "SomeFutureTool", input: {} }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "tool_started", toolUseId: "t1", name: "SomeFutureTool", kind: "other", input: {}, subject: { kind: "other", label: "SomeFutureTool" } }]);
});

test("assistant: TodoWrite emits plan instead of tool_started, with structured todos", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "TodoWrite",
          input: { todos: [{ content: "write tests", status: "in_progress", activeForm: "Writing tests" }] },
        },
      ],
    },
  };
  assert.deepEqual(mapClaudeEvent(event), [
    { type: "plan", toolUseId: "t1", todos: [{ content: "write tests", status: "in_progress", activeForm: "Writing tests" }] },
  ]);
});

test("assistant: TodoWrite with a malformed todos field maps to an empty list instead of throwing", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: "not an array" } }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "plan", toolUseId: "t1", todos: [] }]);
});

// ---- user: tool_result -------------------------------------------------------

test("user: tool_result with string content becomes tool_ended", () => {
  const event: ClaudeEvent = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "tool_ended", toolUseId: "t1", content: "ok", isError: false }]);
});

test("user: tool_result with content as an array of text blocks is flattened to plain text (not JSON.stringify'd) so marker detection still works", () => {
  const event: ClaudeEvent = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line one" }] }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "tool_ended", toolUseId: "t1", content: "line one", isError: false }]);
});

test("user: tool_result content that isn't a string or text-block array falls back to JSON.stringify", () => {
  const event: ClaudeEvent = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: { weird: true } }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "tool_ended", toolUseId: "t1", content: '{"weird":true}', isError: false }]);
});

test("user: tool_result with is_error true is reported as an error result", () => {
  const event: ClaudeEvent = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
  };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "tool_ended", toolUseId: "t1", content: "boom", isError: true }]);
});

test("user: tool_result's diff comes from the event's tool_use_result, not the block itself", () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];
  const event: ClaudeEvent = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    tool_use_result: { filePath: "/a.ts", structuredPatch: patch },
  };
  assert.deepEqual(mapClaudeEvent(event), [
    { type: "tool_ended", toolUseId: "t1", content: "ok", isError: false, outcome: { kind: "diff", path: "/a.ts", hunks: patch, added: 1, removed: 1 } },
  ]);
});

// ---- stream_event -----------------------------------------------------------

test("stream_event: content_block_delta text_delta becomes text_delta", () => {
  const event: ClaudeEvent = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "text_delta", index: 0, text: "he" }]);
});

test("stream_event: content_block_delta thinking_delta becomes thinking_delta", () => {
  const event: ClaudeEvent = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "thinking_delta", index: 0, thinking: "hm" }]);
});

test("stream_event: message_start/content_block_start/stop/message_delta/message_stop map to nothing (no consumer today)", () => {
  for (const type of ["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]) {
    const event: ClaudeEvent = { type: "stream_event", event: { type } };
    assert.deepEqual(mapClaudeEvent(event), [], type);
  }
});

test("stream_event: input_json_delta (tool argument streaming) maps to nothing — no def emits tool_input_delta yet", () => {
  const event: ClaudeEvent = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } } };
  assert.deepEqual(mapClaudeEvent(event), []);
});

// ---- system -------------------------------------------------------------------

test("system: init carries the session id", () => {
  const event: ClaudeEvent = { type: "system", subtype: "init", session_id: "sess-1" };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "session_id", sessionId: "sess-1" }]);
});

test("system: compact_boundary passes through trigger/preTokens", () => {
  const event: ClaudeEvent = { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 123 } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "compact_boundary", trigger: "auto", preTokens: 123 }]);
});

test("system: status with a permissionMode string becomes a status event", () => {
  const event: ClaudeEvent = { type: "system", subtype: "status", permissionMode: "acceptEdits" };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "status", permissionMode: "acceptEdits" }]);
});

test("system: an unrecognized subtype with no session_id maps to nothing, doesn't throw", () => {
  const event: ClaudeEvent = { type: "system", subtype: "some-future-subtype" };
  assert.deepEqual(mapClaudeEvent(event), []);
});

// ---- result / unknown ------------------------------------------------------

test("result: carries the session id when present", () => {
  const event: ClaudeEvent = { type: "result", session_id: "sess-1", is_error: false, result: "done" };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "session_id", sessionId: "sess-1" }]);
});

test("result: no session_id maps to nothing", () => {
  const event: ClaudeEvent = { type: "result", is_error: true, result: "boom" };
  assert.deepEqual(mapClaudeEvent(event), []);
});

test("an unrecognized top-level event type maps to nothing instead of throwing", () => {
  const event: ClaudeEvent = { type: "some-future-event-type" };
  assert.deepEqual(mapClaudeEvent(event), []);
});

// ---- normalized tool calls -------------------------------------------------

test("assistant: a tool_use carries its subject and the message id as batch", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: {
      id: "msg_1",
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
      ],
    },
  };
  const [first, second] = mapClaudeEvent(event);
  assert.deepEqual(first, { type: "tool_started", toolUseId: "t1", name: "Read", kind: "read", input: { file_path: "/a.ts" }, subject: { kind: "read", path: "/a.ts" }, batchId: "msg_1" });
  assert.equal(second?.type === "tool_started" && second.batchId, "msg_1");
});

test("a replayed tool result is interpreted with the input of the call it answers", () => {
  const memos = new Map();
  mapClaudeEvent({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "mcp__linear__get", input: { id: "X-1" } }] } }, memos);
  const [ended] = mapClaudeEvent(
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "{}" }] }, tool_use_result: [{ type: "text", text: "{}" }] },
    memos,
  );
  assert.deepEqual(ended, { type: "tool_ended", toolUseId: "t", content: "{}", isError: false, outcome: { kind: "payload", request: JSON.stringify({ id: "X-1" }, null, 2), response: "{}" } });
});

test("stream_event: the start of a thinking block is reported so it can show as running", () => {
  const event: ClaudeEvent = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } };
  assert.deepEqual(mapClaudeEvent(event), [{ type: "thinking_started" }]);
  const text: ClaudeEvent = { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } };
  assert.deepEqual(mapClaudeEvent(text), []);
});

// ---- subagents -----------------------------------------------------------
// Shapes trimmed from real `claude -p` 2.1.284 output: one foreground and one
// `run_in_background` subagent, each reading two files.

test("a subagent's own events carry the spawning call's id as parentToolUseId", () => {
  const toolUse: ClaudeEvent = {
    type: "assistant",
    parent_tool_use_id: "toolu_agent",
    message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/w/a.txt" } }] },
  };
  const result: ClaudeEvent = {
    type: "user",
    parent_tool_use_id: "toolu_agent",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "1\talpha" }] },
  };
  const text: ClaudeEvent = { type: "assistant", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "text", text: "Done." }] } };
  assert.deepEqual(mapClaudeEvent(toolUse), [
    { type: "tool_started", toolUseId: "toolu_read", name: "Read", kind: "read", input: { file_path: "/w/a.txt" }, subject: { kind: "read", path: "/w/a.txt" }, parentToolUseId: "toolu_agent" },
  ]);
  assert.deepEqual(mapClaudeEvent(result), [
    { type: "tool_ended", toolUseId: "toolu_read", content: "1\talpha", isError: false, parentToolUseId: "toolu_agent" },
  ]);
  assert.deepEqual(mapClaudeEvent(text), [{ type: "text", text: "Done.", parentToolUseId: "toolu_agent" }]);
});

test("the Agent tool (Task's newer name) is classified as a task", () => {
  const event: ClaudeEvent = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "audit", run_in_background: true } }] },
  };
  const [started] = mapClaudeEvent(event);
  assert.equal(started.type === "tool_started" && started.kind, "task");
});

function withoutAt(events: ReturnType<typeof mapClaudeEvent>): unknown[] {
  return events.map((event) => {
    if (event.type !== "subagent") return event;
    assert.equal(typeof event.at, "number");
    const { at: _at, ...rest } = event;
    return rest;
  });
}

test("task_started/task_progress/task_notification of an agent map to its subagent lifecycle", () => {
  const started: ClaudeEvent = {
    type: "system",
    subtype: "task_started",
    task_id: "a1",
    tool_use_id: "toolu_agent",
    description: "Read a.txt and b.txt",
    subagent_type: "general-purpose",
    is_backgrounded: true,
    task_type: "local_agent",
  };
  const progress: ClaudeEvent = {
    type: "system",
    subtype: "task_progress",
    task_id: "a1",
    tool_use_id: "toolu_agent",
    description: "Reading a.txt",
    subagent_type: "general-purpose",
    usage: { total_tokens: 18440, tool_uses: 1, duration_ms: 2388 },
    last_tool_name: "Read",
  };
  const done: ClaudeEvent = {
    type: "system",
    subtype: "task_notification",
    task_id: "a1",
    tool_use_id: "toolu_agent",
    status: "completed",
    summary: "alpha, beta",
    usage: { total_tokens: 21377, tool_uses: 2, duration_ms: 4294 },
  };
  assert.deepEqual(withoutAt(mapClaudeEvent(started)), [
    { type: "subagent", toolUseId: "toolu_agent", status: "running", description: "Read a.txt and b.txt", background: true },
  ]);
  assert.deepEqual(withoutAt(mapClaudeEvent(progress)), [
    { type: "subagent", toolUseId: "toolu_agent", status: "running", activity: "Reading a.txt", toolUses: 1, totalTokens: 18440 },
  ]);
  assert.deepEqual(withoutAt(mapClaudeEvent(done)), [
    { type: "subagent", toolUseId: "toolu_agent", status: "completed", summary: "alpha, beta", toolUses: 2, totalTokens: 21377 },
  ]);
});

test("a non-agent task (a subagent's own backgrounded Bash) never starts a subagent", () => {
  const event: ClaudeEvent = {
    type: "system",
    subtype: "task_started",
    task_id: "b1",
    owned_by_subagent: true,
    tool_use_id: "toolu_bash",
    description: "Sleep for 8 seconds",
    is_backgrounded: false,
    task_type: "local_bash",
  };
  assert.deepEqual(mapClaudeEvent(event), []);
});
