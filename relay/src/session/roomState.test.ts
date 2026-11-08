import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoomAgentState } from "./room.js";
import type { SubtaskInfo } from "../runtimes/sessionDriver.js";
import { ROOM_SUBTASKS_SENT, roomTickets, subtaskViews, summarizeRoom, type RoomAgentView } from "./roomState.js";

const view = (state: RoomAgentState, needsYou: RoomAgentView["needsYou"] = []): RoomAgentView => ({
  agentId: `a-${Math.random()}`,
  role: "worker",
  title: null,
  runtime: "claude",
  model: null,
  createdBy: "agent",
  state,
  queuedMessages: 0,
  needsYou,
  subtasksRunning: 0, connectors: [],
});
const ask = { kind: "approval" as const, promptId: "p", count: 1 };

test("the summary counts every state, the agents waiting for the person, and the places taken", () => {
  const summary = summarizeRoom([view("working"), view("working", [ask]), view("awaiting_user", [ask]), view("queued"), view("done"), view("failed"), view("stopped")]);
  assert.deepEqual(summary.counts, { working: 2, awaiting_user: 1, queued: 1, waiting: 0, done: 1, blocked: 0, failed: 1, stopped: 1 });
  assert.equal(summary.needsYou, 2, "a working agent that already asked something else still counts");
  assert.equal(summary.live, 3, "working and queued hold a place; waiting for the person does not");
  assert.equal(summary.liveLimit, 10);
});

test("an empty room has every count at zero", () => {
  const summary = summarizeRoom([]);
  assert.ok(Object.values(summary.counts).every((n) => n === 0));
  assert.equal(summary.needsYou, 0);
});

const subtask = (taskId: string, startedAt: number, extra: Partial<SubtaskInfo> = {}): SubtaskInfo => ({ taskId, toolUseId: `tu-${taskId}`, status: "running", background: true, startedAt, ...extra });

test("an agent's subtasks go out oldest first: every running one, then the most recent finished, up to the cap", () => {
  const finished = Array.from({ length: 10 }, (_, i) => subtask(`f${i}`, i, { status: "completed", endedAt: 100 + i }));
  const views = subtaskViews([...finished, subtask("r1", 50), subtask("r2", 60)]);
  assert.equal(views.length, ROOM_SUBTASKS_SENT);
  assert.deepEqual(
    views.map((view) => view.taskId),
    ["f4", "f5", "f6", "f7", "f8", "f9", "r1", "r2"],
    "the oldest finished make room, the running are never cut, the order is when each started",
  );
});

test("each text goes out as one line: the activity while running, the summary's first line once ended", () => {
  const long = "x".repeat(200);
  const [running, ended] = subtaskViews([
    subtask("a", 1, { activity: `${long}\nmore`, summary: "never sent", totalTokens: 10, toolUses: 1, description: "Look", subagentType: "Explore" }),
    subtask("b", 2, { status: "failed", activity: "stale", summary: "\n  Could not read\nthe rest", endedAt: 3 }),
  ]);
  assert.equal(running.activity?.length, 60);
  assert.ok(running.activity?.endsWith("…"));
  assert.equal(running.summaryLine, undefined);
  assert.deepEqual([running.totalTokens, running.toolUses, running.description, running.subagentType], [10, 1, "Look", "Explore"]);
  assert.deepEqual([ended.activity, ended.summaryLine, ended.endedAt], [undefined, "Could not read", 3]);
});

test("the subtask a pending approval came from is marked, by its task id or its Agent call's id; a finished one never is", () => {
  const views = subtaskViews([subtask("a", 1), subtask("b", 2), subtask("c", 3, { status: "stopped", endedAt: 4 }), subtask("d", 4)], new Set(["a", "tu-b", "c"]));
  assert.deepEqual(views.map((view) => view.needsYou ?? false), [true, true, false, false]);
});

test("a room's tickets: one per ticket its agents work on, with them, then those only the principal holds", () => {
  const agent = (agentId: string, key?: string, role: RoomAgentView["role"] = "worker", title?: string): RoomAgentView => ({
    ...view("working"),
    agentId,
    role,
    ...(key ? { ticket: { provider: "jira" as const, key, ...(title ? { title } : {}) } } : {}),
  });
  const agents = [agent("p", "NGL-0", "principal"), agent("a", "NGL-9"), agent("b"), agent("c", "NGL-9", "worker", "Fix the login"), agent("d", "ABC-1")];
  assert.deepEqual(
    roomTickets(agents, [
      { provider: "jira", key: "NGL-9" },
      { provider: "jira", key: "NGL-4", title: "Release notes" },
    ]),
    [
      { provider: "jira", key: "NGL-9", title: "Fix the login", agentIds: ["a", "c"] },
      { provider: "jira", key: "ABC-1", agentIds: ["d"] },
      { provider: "jira", key: "NGL-4", title: "Release notes", agentIds: [], carried: true },
    ],
  );
  assert.deepEqual(roomTickets([agent("b")]), []);
});
