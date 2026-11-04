// The state of a whole room as one thing: what each agent is doing, who is
// waiting for the person, and the totals a room's header needs. Built from
// what is persisted plus whether an agent has a turn running, so it reads the
// same whether an agent's process is awake or hibernated. Pure.
import type { RoomAction } from "./roomActivity.js";
import type { SubtaskInfo } from "../runtimes/sessionDriver.js";
import { ROOM_MAX_LIVE_AGENTS, takesRoomPlace, type RoomAgentState, type RoomReport, type RoomRole } from "./room.js";

/** A question or a tool approval waiting for the person. */
export interface NeedsYou {
  kind: "approval" | "choice";
  promptId: string;
  /** Epoch ms the person was first asked; absent for an old record. */
  askedAt?: number;
  /** How many questions (or refused tool calls) the card holds. */
  count: number;
  /** The first question's words, cut to one line, so the agent's card can
   * show what it asks without opening the card. */
  question?: string;
}

/** One native subagent of an agent, as its card on the room's canvas shows
 * it: one line of each text, never the whole summary (the channel sends the
 * whole agent on every change). */
export interface RoomSubtaskView {
  taskId: string;
  toolUseId: string;
  status: SubtaskInfo["status"];
  /** Its title, as the parent model wrote it. */
  description?: string;
  subagentType?: string;
  /** What it is doing, one line. */
  activity?: string;
  /** The first line of how it ended. */
  summaryLine?: string;
  startedAt: number;
  endedAt?: number;
  totalTokens?: number;
  toolUses?: number;
  /** A pending approval of the parent came from it (best effort: the
   * approval stays the parent's, this only marks where it came from). */
  needsYou?: true;
}

/** Subtasks sent per agent: every running one, then the latest finished. */
export const ROOM_SUBTASKS_SENT = 8;
const SUBTASK_ACTIVITY_MAX = 60;
const SUBTASK_SUMMARY_MAX = 80;

function oneLine(text: string | undefined, max: number): string | undefined {
  const line = text?.split("\n").find((l) => l.trim() !== "")?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** An agent's subtasks for the channel, oldest first: all the running ones
 * and the most recent finished ones, up to `ROOM_SUBTASKS_SENT`. `askedBy`
 * holds the origins of the parent's pending approval calls (a task id or the
 * `Agent` call's tool-use id, whichever the request carried). */
export function subtaskViews(subtasks: readonly SubtaskInfo[], askedBy: ReadonlySet<string> = new Set()): RoomSubtaskView[] {
  const running = subtasks.filter((subtask) => subtask.status === "running");
  const finished = [...subtasks.filter((subtask) => subtask.status !== "running")].sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const kept = new Set([...running, ...finished].slice(0, ROOM_SUBTASKS_SENT));
  return subtasks
    .filter((subtask) => kept.has(subtask))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((subtask) => {
      const activity = subtask.status === "running" ? oneLine(subtask.activity, SUBTASK_ACTIVITY_MAX) : undefined;
      const summaryLine = subtask.status === "running" ? undefined : oneLine(subtask.summary, SUBTASK_SUMMARY_MAX);
      return {
        taskId: subtask.taskId,
        toolUseId: subtask.toolUseId,
        status: subtask.status,
        ...(subtask.description ? { description: subtask.description } : {}),
        ...(subtask.subagentType ? { subagentType: subtask.subagentType } : {}),
        ...(activity ? { activity } : {}),
        ...(summaryLine ? { summaryLine } : {}),
        startedAt: subtask.startedAt,
        ...(subtask.endedAt !== undefined ? { endedAt: subtask.endedAt } : {}),
        ...(subtask.totalTokens !== undefined ? { totalTokens: subtask.totalTokens } : {}),
        ...(subtask.toolUses !== undefined ? { toolUses: subtask.toolUses } : {}),
        ...(subtask.status === "running" && (askedBy.has(subtask.taskId) || askedBy.has(subtask.toolUseId)) ? { needsYou: true as const } : {}),
      };
    });
}

export interface RoomAgentView {
  agentId: string;
  role: RoomRole;
  parentId?: string;
  title: string | null;
  /** `true` while `title` is only the provisional text (the task's first
   * line) and a short generated one is on its way. */
  titlePending?: true;
  runtime: string;
  model: string | null;
  area?: string;
  createdBy: "user" | "agent";
  state: RoomAgentState;
  queuedMessages: number;
  report?: Pick<RoomReport, "status" | "summary" | "artifacts" | "at"> & { fromRelay?: boolean };
  /** What waits for the person: normally with `state` `awaiting_user`, but an
   * agent that goes on working can have asked about something else. Empty for
   * an agent that was stopped or removed. */
  needsYou: NeedsYou[];
  /** Epoch ms its latest turn began; absent if it never ran. */
  startedAt?: number;
  /** MCP servers (connectors) it has used. */
  connectors: string[];
  /** Native subagents the agent has running right now. */
  subtasksRunning: number;
  /** Its native subagents, cut as `subtaskViews` does; absent for an agent
   * whose runtime does not track them (and from an older relay). */
  subtasks?: RoomSubtaskView[];
  /** Its latest actions, oldest first (a tool call, a bout of reasoning),
   * for the card's log. Not kept with the room: it is added when the state
   * is sent. */
  activity?: RoomAction[];
}

export interface RoomSummary {
  /** Agents per state (every state present, so a client needs no default). */
  counts: Record<RoomAgentState, number>;
  /** Agents with a question or approval waiting: what a room's "your turn"
   * badge counts, whatever else those agents are doing. */
  needsYou: number;
  /** Agents holding a place under the room's cap. */
  live: number;
  liveLimit: number;
}

const STATES: readonly RoomAgentState[] = ["working", "awaiting_user", "queued", "waiting", "done", "blocked", "failed", "stopped"];

export function summarizeRoom(agents: readonly RoomAgentView[]): RoomSummary {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<RoomAgentState, number>;
  let needsYou = 0;
  let live = 0;
  for (const agent of agents) {
    counts[agent.state] += 1;
    if (agent.needsYou.length > 0) needsYou += 1;
    if (takesRoomPlace(agent.state)) live += 1;
  }
  return { counts, needsYou, live, liveLimit: ROOM_MAX_LIVE_AGENTS };
}

export interface RoomSnapshot {
  roomId: string;
  agents: RoomAgentView[];
  summary: RoomSummary;
}
