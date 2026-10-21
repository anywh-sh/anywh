import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../protocol/agent-event.js";
import { ActivityTrail, describeCall } from "./roomActivity.js";

const start = (toolUseId: string, subject: Extract<AgentEvent, { type: "tool_started" }>["subject"], startedAt: number, extra: object = {}): AgentEvent => ({
  type: "tool_started",
  toolUseId,
  name: "Tool",
  kind: "other",
  input: {},
  subject,
  startedAt,
  ...extra,
});
const end = (toolUseId: string, endedAt: number, isError = false): AgentEvent => ({ type: "tool_ended", toolUseId, content: "", isError, endedAt });

describe("ActivityTrail", () => {
  it("records a call as it starts and closes it when it ends", () => {
    const trail = new ActivityTrail();
    assert.equal(trail.observe("a", start("1", { kind: "read", path: "/w/src/socket.ts" }, 100)), true);
    assert.deepEqual(trail.recent("a"), [{ id: "1", verb: "read", target: "socket.ts", startedAt: 100 }]);
    assert.equal(trail.observe("a", end("1", 250)), true);
    assert.deepEqual(trail.recent("a"), [{ id: "1", verb: "read", target: "socket.ts", startedAt: 100, endedAt: 250 }]);
  });

  it("keeps only the latest three, oldest first", () => {
    const trail = new ActivityTrail();
    for (let i = 1; i <= 5; i++) trail.observe("a", start(String(i), { kind: "shell", command: `cmd ${String(i)}` }, i * 10));
    assert.deepEqual(
      trail.recent("a").map((a) => a.id),
      ["3", "4", "5"],
    );
  });

  it("marks a failed call", () => {
    const trail = new ActivityTrail();
    trail.observe("a", start("1", { kind: "shell", command: "npm test" }, 1));
    trail.observe("a", end("1", 2, true));
    assert.equal(trail.recent("a")[0]?.failed, true);
  });

  it("records reasoning, closing the open bout when it is committed", () => {
    const trail = new ActivityTrail();
    trail.observe("a", { type: "thinking_started", startedAt: 10 });
    assert.deepEqual(trail.recent("a"), [{ id: "think-1", verb: "think", startedAt: 10 }]);
    trail.observe("a", { type: "thinking", thinking: "", startedAt: 10, endedAt: 40 });
    assert.deepEqual(trail.recent("a"), [{ id: "think-1", verb: "think", startedAt: 10, endedAt: 40 }]);
  });

  it("closes whatever never reported its end when the turn ends", () => {
    const trail = new ActivityTrail();
    trail.observe("a", start("1", { kind: "web", mode: "search", query: "x" }, 5), 5);
    trail.observe("a", { type: "turn_ended", stopped: true }, 99);
    assert.equal(trail.recent("a")[0]?.endedAt, 99);
  });

  it("ignores subagents, the relay's own bridges and unrelated events", () => {
    const trail = new ActivityTrail();
    assert.equal(trail.observe("a", start("1", { kind: "read", path: "/x" }, 1, { parentToolUseId: "t" })), false);
    assert.equal(trail.observe("a", start("2", { kind: "mcp", server: "anywh-room", tool: "report" }, 1)), false);
    assert.equal(trail.observe("a", { type: "text", text: "hi" }), false);
    assert.deepEqual(trail.recent("a"), []);
  });

  it("keeps one agent's trail apart from another's and forgets on request", () => {
    const trail = new ActivityTrail();
    trail.observe("a", start("1", { kind: "mcp", server: "linear", tool: "get_issue" }, 1));
    assert.deepEqual(trail.recent("b"), []);
    assert.equal(trail.recent("a")[0]?.target, "linear.get_issue");
    trail.forget("a");
    assert.deepEqual(trail.recent("a"), []);
  });
});

describe("describeCall", () => {
  it("names what a call acted on", () => {
    assert.deepEqual(describeCall("Grep", "search", { kind: "search", mode: "files", pattern: "*.ts" }), { verb: "searchFiles", target: "*.ts" });
    assert.deepEqual(describeCall("WebFetch", "web", { kind: "web", mode: "fetch", url: "https://a.dev/x" }), { verb: "webFetch", target: "a.dev" });
    assert.deepEqual(describeCall("Mystery", "other", undefined), { verb: "other", target: "Mystery" });
  });
});
