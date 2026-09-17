import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
  type BroadcastMessage,
  broadcast,
  broadcastBackgroundJobs,
  broadcastChoicePrompt,
  broadcastChoiceResolved,
  broadcastContextUsage,
  broadcastContextUsageReset,
  broadcastConversationReset,
  broadcastCwdState,
  broadcastDraftState,
  broadcastExcept,
  broadcastModelState,
  broadcastPermissionMode,
  broadcastSuggestion,
  broadcastTitle,
  broadcastTurnState,
  sendContextUsage,
  sendModelState,
  sendSuggestion,
} from "./broadcast.js";

/** Records every `send`, parsed back from JSON — enough to assert on shape
 * without a real socket. Cast to `WebSocket` at the call site: only `send`
 * is ever called by anything under test here. */
function fakeSocket(): WebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket & { sent: unknown[] };
}

test("broadcastBackgroundJobs: every client gets the same job list, even empty", () => {
  const a = fakeSocket();
  const b = fakeSocket();
  broadcastBackgroundJobs([a, b], []);
  assert.deepEqual(a.sent, [{ type: "background_job_state", jobs: [] }]);
  assert.deepEqual(b.sent, [{ type: "background_job_state", jobs: [] }]);
});

test("broadcastChoicePrompt: carries promptId, questions and kind through unchanged", () => {
  const client = fakeSocket();
  const prompt = { promptId: "p1", questions: [{ id: "q1", question: "ok?", options: [] }] };
  broadcastChoicePrompt([client], prompt, "approval");
  assert.deepEqual(client.sent, [{ type: "choice_prompt", promptId: "p1", questions: prompt.questions, kind: "approval" }]);
});

test("broadcastChoiceResolved: every connected client is told, not just the one who answered", () => {
  const a = fakeSocket();
  const b = fakeSocket();
  broadcastChoiceResolved([a, b], "p1");
  assert.deepEqual(a.sent, [{ type: "choice_resolved", promptId: "p1" }]);
  assert.deepEqual(b.sent, [{ type: "choice_resolved", promptId: "p1" }]);
});

test("broadcastTurnState: startedAt null means active is false and startedAt is omitted, not null", () => {
  const client = fakeSocket();
  broadcastTurnState([client], null);
  assert.deepEqual(client.sent, [{ type: "turn_state", active: false }]);
});

test("broadcastTurnState: a real timestamp carries through and marks active", () => {
  const client = fakeSocket();
  broadcastTurnState([client], 12345);
  assert.deepEqual(client.sent, [{ type: "turn_state", active: true, startedAt: 12345 }]);
});

test("broadcastCwdState: cwd and locked both carry through", () => {
  const client = fakeSocket();
  broadcastCwdState([client], "/tmp/x", true);
  assert.deepEqual(client.sent, [{ type: "cwd_state", cwd: "/tmp/x", locked: true }]);
});

test("broadcastPermissionMode: the mode and its available list both carry through unchanged", () => {
  const client = fakeSocket();
  const available = [
    { id: "default", pausesForApproval: true },
    { id: "bypassPermissions", pausesForApproval: false },
  ];
  broadcastPermissionMode([client], "plan", available);
  assert.deepEqual(client.sent, [{ type: "permission_mode_state", mode: "plan", available }]);
});

test("broadcastPermissionMode: an empty available list still sends (a client mid-agent-switch, before the new def's list is ready)", () => {
  const client = fakeSocket();
  broadcastPermissionMode([client], "plan", []);
  assert.deepEqual(client.sent, [{ type: "permission_mode_state", mode: "plan", available: [] }]);
});

test("sendModelState: undefined becomes null on the wire — never chosen is a final state, not a gap", () => {
  const client = fakeSocket();
  sendModelState(client, undefined);
  assert.deepEqual(client.sent, [{ type: "model_state", model: null }]);
});

test("broadcastModelState: a chosen model carries through as-is", () => {
  const client = fakeSocket();
  broadcastModelState([client], "opus");
  assert.deepEqual(client.sent, [{ type: "model_state", model: "opus" }]);
});

test("sendContextUsage: no usage yet means nothing is sent at all", () => {
  const client = fakeSocket();
  sendContextUsage(client, undefined);
  assert.deepEqual(client.sent, []);
});

test("broadcastContextUsage: a real usage value carries through", () => {
  const client = fakeSocket();
  const usage = { model: "claude-sonnet-5", contextWindowSize: 200000, usedTokens: 1200 };
  broadcastContextUsage([client], usage);
  assert.deepEqual(client.sent, [{ type: "context_usage_state", usage }]);
});

test("broadcastContextUsageReset: sends usage:null, unlike the guarded sendContextUsage", () => {
  const client = fakeSocket();
  broadcastContextUsageReset([client]);
  assert.deepEqual(client.sent, [{ type: "context_usage_state", usage: null }]);
});

test("broadcastConversationReset: a bare signal, no payload beyond the type", () => {
  const client = fakeSocket();
  broadcastConversationReset([client]);
  assert.deepEqual(client.sent, [{ type: "conversation_reset" }]);
});

test("sendSuggestion: null is a real, sendable state (cleared), not a skip", () => {
  const client = fakeSocket();
  sendSuggestion(client, null);
  assert.deepEqual(client.sent, [{ type: "suggestion", text: null }]);
});

test("broadcastSuggestion: text carries through as-is", () => {
  const client = fakeSocket();
  broadcastSuggestion([client], "try this next");
  assert.deepEqual(client.sent, [{ type: "suggestion", text: "try this next" }]);
});

test("broadcastDraftState: draft text carries through", () => {
  const client = fakeSocket();
  broadcastDraftState([client], "unsent text");
  assert.deepEqual(client.sent, [{ type: "draft_state", draft: "unsent text" }]);
});

test("broadcastTitle: a null title sends nothing to anyone — a session isn't titled yet", () => {
  const client = fakeSocket();
  broadcastTitle([client], null);
  assert.deepEqual(client.sent, []);
});

test("broadcastTitle: a real title reaches every client", () => {
  const a = fakeSocket();
  const b = fakeSocket();
  broadcastTitle([a, b], "My session");
  assert.deepEqual(a.sent, [{ type: "session_title", title: "My session" }]);
  assert.deepEqual(b.sent, [{ type: "session_title", title: "My session" }]);
});

test("broadcast: pushes into history and reaches every client, including the sender", () => {
  const a = fakeSocket();
  const b = fakeSocket();
  const history: BroadcastMessage[] = [];
  const message: BroadcastMessage = { type: "agent_event", event: { type: "turn_ended", stopped: false } };
  broadcast([a, b], history, message);
  assert.deepEqual(history, [message]);
  assert.deepEqual(a.sent, [message]);
  assert.deepEqual(b.sent, [message]);
});

test("broadcastExcept: still pushes into history for a client that connects later, but skips the excluded socket now", () => {
  const origin = fakeSocket();
  const other = fakeSocket();
  const history: BroadcastMessage[] = [];
  const message: BroadcastMessage = { type: "agent_event", event: { type: "error", message: "boom" } };
  broadcastExcept([origin, other], history, message, origin);
  assert.deepEqual(history, [message]);
  assert.deepEqual(origin.sent, []);
  assert.deepEqual(other.sent, [message]);
});
