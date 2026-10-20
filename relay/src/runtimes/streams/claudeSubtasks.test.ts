import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubtaskTracker } from "./claudeSubtasks.js";

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `tu-${taskId}`,
  task_type: "local_agent",
  description: `subtask ${taskId}`,
  is_backgrounded: true,
  ...extra,
});

test("a subagent's life as the CLI reports it: started, progress, stopped by stop_task, or finished", () => {
  let now = 100;
  const tracker = new ClaudeSubtaskTracker(() => now);
  tracker.observe(started("a"));
  tracker.observe(started("b", { is_backgrounded: false }));
  tracker.observe({ type: "system", subtype: "task_started", task_id: "bash1", tool_use_id: "tu-x", task_type: "local_bash" });
  tracker.observe({ type: "system", subtype: "task_progress", task_id: "a", description: "Running Read" });
  assert.deepEqual(
    tracker.list().map((subtask) => [subtask.taskId, subtask.status, subtask.background, subtask.activity]),
    [
      ["a", "running", true, "Running Read"],
      ["b", "running", false, undefined],
    ],
    "a Bash task is not a subtask",
  );
  now = 200;
  tracker.observe({ type: "system", subtype: "task_updated", task_id: "a", patch: { status: "killed" } });
  tracker.observe({ type: "system", subtype: "task_notification", task_id: "a", status: "stopped", summary: "stopped by the user" });
  tracker.observe({ type: "system", subtype: "task_notification", task_id: "b", status: "completed", summary: "found 3 files" });
  assert.deepEqual(tracker.get("a"), { taskId: "a", toolUseId: "tu-a", status: "stopped", background: true, startedAt: 100, endedAt: 200, description: "subtask a", activity: "Running Read", summary: "stopped by the user" });
  assert.equal(tracker.get("b")?.status, "completed");
  assert.equal(tracker.get("b")?.summary, "found 3 files");
  assert.equal(tracker.labelFor("a"), "subtask a");
  assert.equal(tracker.labelFor("nobody"), undefined);
});

test("a resumed subagent runs again under its id; only the most recent finished ones are kept", () => {
  const tracker = new ClaudeSubtaskTracker(() => 1);
  tracker.observe(started("a"));
  tracker.observe({ type: "system", subtype: "task_notification", task_id: "a", status: "completed" });
  tracker.observe(started("a"));
  assert.equal(tracker.get("a")?.status, "running");
  for (let index = 0; index < 60; index++) {
    tracker.observe(started(`t${index}`));
    tracker.observe({ type: "system", subtype: "task_notification", task_id: `t${index}`, status: "failed" });
  }
  tracker.observe(started("last"));
  assert.equal(tracker.list().filter((subtask) => subtask.status !== "running").length, 50);
  assert.equal(tracker.get("a")?.status, "running", "a running one is never dropped");
});
