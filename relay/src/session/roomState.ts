// The state of a whole room as one thing: what each agent is doing, who is
// waiting for the person, and the totals a room's header needs. Built from
// what is persisted plus whether an agent has a turn running, so it reads the
// same whether an agent's process is awake or hibernated. Pure.
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
