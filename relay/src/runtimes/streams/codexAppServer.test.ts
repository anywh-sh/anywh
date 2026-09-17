import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCodexNotification } from "./codexAppServer.js";

// ---- item/started -----------------------------------------------------------

test("item/started: commandExecution becomes tool_started, kind shell", () => {
  const params = { item: { type: "commandExecution", id: "item-1", command: "ls -la" } };
  assert.deepEqual(mapCodexNotification("item/started", params), [
    { type: "tool_started", toolUseId: "item-1", name: "commandExecution", kind: "shell", input: { command: "ls -la" } },
  ]);
});

test("item/started: fileChange becomes tool_started, kind edit", () => {
  const params = { item: { type: "fileChange", id: "item-2" } };
  assert.deepEqual(mapCodexNotification("item/started", params), [
    { type: "tool_started", toolUseId: "item-2", name: "fileChange", kind: "edit", input: {} },
  ]);
});

test("item/started: mcpToolCall becomes tool_started, kind mcp, name is server:tool, arguments pass through as input", () => {
  const params = { item: { type: "mcpToolCall", id: "item-3", server: "anywh-choice", tool: "present_choice", arguments: { question: "?" } } };
  assert.deepEqual(mapCodexNotification("item/started", params), [
    { type: "tool_started", toolUseId: "item-3", name: "anywh-choice:present_choice", kind: "mcp", input: { question: "?" } },
  ]);
});

test("item/started: agentMessage/reasoning/plan starting is a no-op (their content arrives at item/completed)", () => {
  for (const type of ["agentMessage", "reasoning", "plan"]) {
    assert.deepEqual(mapCodexNotification("item/started", { item: { type, id: "x" } }), []);
  }
});

test("item/started: an unrecognized item type is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("item/started", { item: { type: "someFutureItemType", id: "x" } }), []);
});

test("item/started: a missing item doesn't throw", () => {
  assert.deepEqual(mapCodexNotification("item/started", {}), []);
});

// ---- item/completed ----------------------------------------------------------

test("item/completed: agentMessage becomes the committed text", () => {
  const params = { item: { type: "agentMessage", id: "item-1", text: "hello" } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "text", text: "hello" }]);
});

test("item/completed: reasoning becomes thinking, joining multiple content parts", () => {
  const params = { item: { type: "reasoning", id: "item-1", content: ["step one", "step two"] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "thinking", thinking: "step one\nstep two" }]);
});

test("item/completed: reasoning with no content produces nothing", () => {
  const params = { item: { type: "reasoning", id: "item-1", content: [] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), []);
});

test("item/completed: plan is plain text, not a structured todo list — Codex's plan item is free-text prose, unlike Claude's TodoWrite", () => {
  const params = { item: { type: "plan", id: "item-1", text: "1. Do the thing\n2. Then the other thing" } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "text", text: "1. Do the thing\n2. Then the other thing" }]);
});

test("item/completed: commandExecution reports its aggregated output, isError false when completed", () => {
  const params = { item: { type: "commandExecution", id: "item-1", status: "completed", aggregatedOutput: "ok\n", exitCode: 0 } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "tool_ended", toolUseId: "item-1", content: "ok\n", isError: false }]);
});

test("item/completed: commandExecution reports isError true when failed, and a null output falls back to an empty string", () => {
  const params = { item: { type: "commandExecution", id: "item-1", status: "failed", aggregatedOutput: null, exitCode: 1 } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [{ type: "tool_ended", toolUseId: "item-1", content: "", isError: true }]);
});

test("item/completed: commandExecution declined by the user also counts as isError (it's not 'completed')", () => {
  const params = { item: { type: "commandExecution", id: "item-1", status: "declined", aggregatedOutput: null, exitCode: null } };
  assert.equal((mapCodexNotification("item/completed", params)[0] as { isError: boolean }).isError, true);
});

test("item/completed: fileChange reports its changes as JSON, isError false when completed", () => {
  const params = { item: { type: "fileChange", id: "item-1", status: "completed", changes: [{ path: "a.ts" }] } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    { type: "tool_ended", toolUseId: "item-1", content: JSON.stringify([{ path: "a.ts" }]), isError: false },
  ]);
});

test("item/completed: mcpToolCall reports its result, isError false when completed", () => {
  const params = { item: { type: "mcpToolCall", id: "item-1", status: "completed", result: { ok: true }, error: null } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    { type: "tool_ended", toolUseId: "item-1", content: JSON.stringify({ ok: true }), isError: false },
  ]);
});

test("item/completed: mcpToolCall reports its error over its result, isError true when failed", () => {
  const params = { item: { type: "mcpToolCall", id: "item-1", status: "failed", result: null, error: { message: "boom" } } };
  assert.deepEqual(mapCodexNotification("item/completed", params), [
    { type: "tool_ended", toolUseId: "item-1", content: JSON.stringify({ message: "boom" }), isError: true },
  ]);
});

test("item/completed: an unrecognized item type is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("item/completed", { item: { type: "sleep", id: "x" } }), []);
});

// ---- deltas and usage ---------------------------------------------------------

test("item/agentMessage/delta produces nothing — a known, declared gap (see the mapper's own comment), not a bug", () => {
  assert.deepEqual(mapCodexNotification("item/agentMessage/delta", { threadId: "t", turnId: "u", itemId: "i", delta: "hel" }), []);
});

test("thread/tokenUsage/updated maps the LAST response's breakdown, renaming Codex's field names to AgentEvent's", () => {
  const params = {
    tokenUsage: {
      total: { totalTokens: 999, inputTokens: 999, cachedInputTokens: 999, cacheWriteInputTokens: 999, outputTokens: 999, reasoningOutputTokens: 999 },
      last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 15, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  };
  assert.deepEqual(mapCodexNotification("thread/tokenUsage/updated", params), [
    { type: "usage", inputTokens: 100, cacheCreationInputTokens: 5, cacheReadInputTokens: 20 },
  ]);
});

test("thread/tokenUsage/updated with no 'last' breakdown produces nothing", () => {
  assert.deepEqual(mapCodexNotification("thread/tokenUsage/updated", { tokenUsage: {} }), []);
});

// ---- unrecognized notifications -------------------------------------------

test("an unrecognized top-level method is dropped, not thrown", () => {
  assert.deepEqual(mapCodexNotification("marketplace/add/completed", { anything: true }), []);
});
