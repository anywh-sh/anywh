// The native subagents a Claude agent runs inside its own turn, as subtasks
// of that agent: what each one is doing and how it ended, kept from the CLI's
// own task events. Measured on Claude Code 2.1.303: `system/task_started`
// (`task_type: "local_agent"`, with `task_id`, `tool_use_id`, `description`,
// `is_backgrounded`), `system/task_progress`, `system/task_updated` (`patch`
// with the new `status`) and `system/task_notification` (the end, with
// `status` and `summary`). A subtask is stopped with the stream-json control
// request `stop_task` naming its `task_id`, which ends that subagent alone.
//
// Pure: fed one event at a time.
import type { SubtaskInfo } from "../sessionDriver.js";

/** How many finished subtasks are kept after they end. */
const KEEP_FINISHED = 50;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function endStatus(status: unknown): SubtaskInfo["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error") return "failed";
  return "stopped";
}

export class ClaudeSubtaskTracker {
  private readonly byId = new Map<string, SubtaskInfo>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(event: Record<string, unknown>): void {
    if (event.type !== "system") return;
    const taskId = str(event.task_id);
    if (!taskId) return;
    const known = this.byId.get(taskId);
    switch (event.subtype) {
      case "task_started": {
        if (event.task_type !== "local_agent") return;
        const toolUseId = str(event.tool_use_id);
        if (!toolUseId) return;
        // A subagent resumed by its parent comes back under the same id.
        this.byId.set(taskId, {
          taskId,
          toolUseId,
          status: "running",
          background: event.is_backgrounded === true,
          startedAt: this.now(),
          ...(str(event.description) ? { description: str(event.description) } : {}),
          ...(str(event.subagent_type) ? { subagentType: str(event.subagent_type) } : {}),
        });
        this.prune();
        return;
      }
      case "task_progress":
        if (known?.status === "running") this.byId.set(taskId, { ...known, ...(str(event.description) ? { activity: str(event.description) } : {}) });
        return;
      case "task_updated": {
        const patch = event.patch as { status?: unknown } | undefined;
        if (known?.status === "running" && (patch?.status === "killed" || patch?.status === "completed" || patch?.status === "failed")) {
          this.byId.set(taskId, { ...known, status: patch.status === "killed" ? "stopped" : endStatus(patch.status), endedAt: this.now() });
        }
        return;
      }
      case "task_notification":
        if (!known) return;
        this.byId.set(taskId, { ...known, status: endStatus(event.status), endedAt: known.endedAt ?? this.now(), ...(str(event.summary) ? { summary: str(event.summary) } : {}) });
        return;
      default:
        return;
    }
  }

  /** Oldest first. */
  list(): SubtaskInfo[] {
    return [...this.byId.values()];
  }

  get(taskId: string): SubtaskInfo | undefined {
    return this.byId.get(taskId);
  }

  /** The label of the subtask a permission request with this `agent_id`
   * came from (the CLI tags a native subagent's `can_use_tool` request with
   * it), so the request can be shown as the parent agent's own pending
   * approval, named after the subtask. */
  labelFor(agentId: string): string | undefined {
    const subtask = this.byId.get(agentId);
    return subtask ? (subtask.description ?? subtask.taskId) : undefined;
  }

  private prune(): void {
    const finished = [...this.byId.values()].filter((subtask) => subtask.status !== "running");
    for (const subtask of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.byId.delete(subtask.taskId);
  }
}
