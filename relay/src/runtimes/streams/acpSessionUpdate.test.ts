import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentEvent } from "../../protocol/agent-event.js";
import { createAcpTurnState, flushAcpTurn, mapAcpUpdate, type AcpTurnState } from "./acpSessionUpdate.js";

// Recorded from Kimi Code CLI 2.6.0 (`kimi acp`), see the fixture's own `cli`
// field: a turn that writes a file and runs `ls` (with a permission request
// in between), a turn that asks a question, and a history replay.
interface Fixture {
  readonly writeAndBashTurn: unknown[];
  readonly questionTurn: unknown[];
  readonly replay: unknown[];
}
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../tests/fixtures/kimi-acp-2.6.0-updates.json"), "utf8")) as Fixture;

const options = { logTag: "test", hiddenTools: new Set(["AskUserQuestion"]) };

function run(updates: readonly unknown[], state: AcpTurnState = createAcpTurnState()): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const update of updates) {
    if (typeof update === "object" && update !== null && "__request_permission" in update) continue;
    events.push(...mapAcpUpdate({ sessionId: "s", update }, state, options));
  }
  events.push(...flushAcpTurn(state));
  return events;
}

const withoutDeltas = (events: AgentEvent[]) => events.filter((event) => event.type !== "text_delta" && event.type !== "thinking_delta");

test("a recorded turn: each thought committed before the call after it, one tool card per call with its real input, one reply", () => {
  const events = withoutDeltas(run(fixture.writeAndBashTurn));
  const shape = events.map((event) => event.type);
  assert.deepEqual(shape, ["thinking_started", "thinking", "tool_started", "tool_ended", "thinking_started", "thinking", "tool_started", "tool_ended", "thinking_started", "thinking", "text"]);

  const [write, bash] = events.filter((event) => event.type === "tool_started");
  // The name comes from the first announcement, the input from the update
  // that carried it parsed — never from the half-streamed JSON before it.
  assert.equal(write.name, "Write");
  assert.deepEqual(write.subject, { kind: "write", path: "hello.txt" });
  assert.equal(write.kind, "write");
  assert.equal(bash.name, "Bash");
  assert.deepEqual(bash.subject, { kind: "shell", command: "ls" });

  const bashEnd = events.filter((event) => event.type === "tool_ended")[1];
  assert.deepEqual(bashEnd.outcome, { kind: "terminal", output: "hello.txt\n" });
  assert.equal(bashEnd.isError, false);
});

test("the reply's chunks stream as deltas of one block and commit as one text", () => {
  const events = run(fixture.writeAndBashTurn);
  const deltas = events.filter((event) => event.type === "text_delta");
  const text = events.find((event) => event.type === "text");
  assert.ok(deltas.length > 1);
  assert.equal(new Set(deltas.map((delta) => delta.index)).size, 1, "every chunk of one message shares an index");
  assert.equal(text?.text, deltas.map((delta) => delta.text).join(""));
});

test("the question tool stays out of the log: the choice card is its only face", () => {
  const events = run(fixture.questionTurn);
  assert.equal(events.filter((event) => event.type === "tool_started" || event.type === "tool_ended").length, 0);
  assert.ok(events.some((event) => event.type === "text"));
});

test("a replay rebuilds the turn boundary from the user's message and drops the injected reminder", () => {
  const events = withoutDeltas(run(fixture.replay));
  const users = events.filter((event) => event.type === "user_message");
  assert.equal(users.length, 2);
  assert.ok(users.every((user) => !user.text.includes("system-reminder")));
  assert.equal(events[0].type, "turn_started");
  assert.equal(events.at(-1)?.type, "turn_ended");
  assert.equal(events.filter((event) => event.type === "turn_started").length, 2);
});

test("usage_update carries the session's whole context and the model's window", () => {
  const events = mapAcpUpdate({ update: { sessionUpdate: "usage_update", used: 14495, size: 1048576 } }, createAcpTurnState(), options);
  assert.deepEqual(events, [{ type: "usage", inputTokens: 14495, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, prefixTokens: 14495, outputTokens: 0, contextWindowSize: 1048576 }]);
});

test("a failed call ends as an error with the agent's own explanation", () => {
  const state = createAcpTurnState();
  const events = [
    ...mapAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Bash", kind: "execute", status: "pending" } }, state, options),
    ...mapAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "t", kind: "execute", status: "in_progress", rawInput: { command: "rm x" } } }, state, options),
    ...mapAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed", rawOutput: "rejected" } }, state, options),
  ];
  const ended = events.find((event) => event.type === "tool_ended");
  assert.deepEqual(ended, { type: "tool_ended", toolUseId: "t", content: "rejected", isError: true, outcome: { kind: "terminal", output: "rejected" } });
});

test("a call that ends without ever reporting its input still pairs a start with its end", () => {
  const state = createAcpTurnState();
  const events = [
    ...mapAcpUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Think", kind: "think", status: "pending" } }, state, options),
    ...mapAcpUpdate({ update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] } }, state, options),
  ];
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_started", "tool_ended"],
  );
  const started = events[0] as Extract<AgentEvent, { type: "tool_started" }>;
  assert.deepEqual(started.subject, { kind: "other", label: "Think" });
});

test("an ACP plan becomes the structured plan event", () => {
  const events = mapAcpUpdate(
    { update: { sessionUpdate: "plan", entries: [{ content: "a", status: "completed", priority: "high" }, { content: "b", status: "in_progress" }, { content: "c", status: "weird" }] } },
    createAcpTurnState(),
    options,
  );
  assert.deepEqual(events, [{ type: "plan", todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }] }]);
});

test("a mode the agent switched to on its own is reported as a status change", () => {
  assert.deepEqual(mapAcpUpdate({ update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } }, createAcpTurnState(), options), [{ type: "status", permissionMode: "plan" }]);
});

test("shapes it doesn't know are dropped, never thrown on", () => {
  const state = createAcpTurnState();
  for (const params of [null, 1, {}, { update: null }, { update: { sessionUpdate: "something_new" } }, { update: { sessionUpdate: "agent_message_chunk", content: { type: "image" } } }]) {
    assert.deepEqual(mapAcpUpdate(params, state, options), []);
  }
});
