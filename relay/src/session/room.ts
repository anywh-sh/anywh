// What a session knows about the room it belongs to. A room is a group of
// agents working for one person: a principal (the session the person talks
// to, which only delegates) and the workers it started. Each agent is an
// ordinary session (`SessionEntry`), so everything a session already has
// (its agent, model, permission mode, cwd, conversation) applies to it
// unchanged; this is only the part that ties it to the room.
//
// Persisted (`SessionEntry.room`) is only what must survive a relay restart:
// who belongs to which room, who reports to whom, what each one was asked,
// its report, and whether it was stopped. Whether an agent is starting,
// working or waiting is live state, derived elsewhere, never stored.
//
// Pure: no I/O, so the validation and the tree rules are testable as tables.

export type RoomRole = "principal" | "worker";

export type RoomReportStatus = "done" | "failed" | "blocked";

export interface RoomReport {
  status: RoomReportStatus;
  summary: string;
  /** Paths of what the agent produced (files of the room's folder, a
   * branch, ...), as the agent named them. */
  artifacts: string[];
  /** Epoch ms when the report arrived. */
  at: number;
  /** Written by the relay, not the agent: its turn failed (`failed`), or it
   * ended its turn without reporting (`blocked`). */
  synthetic?: boolean;
}

/** A message for a worker that has not reached it yet (it was busy, or the
 * relay restarted before delivering it). Delivered in order, one turn each. */
export interface QueuedMessage {
  text: string;
  at: number;
  /** Written by the relay, not sent by anyone: the agent ended a turn
   * without reporting and is asked for its report once. */
  reminder?: true;
}

export interface RoomStop {
  reason: "user" | "relay_restart" | "removed";
  at: number;
}

export interface RoomMembership {
  /** The principal's session id. */
  roomId: string;
  role: RoomRole;
  /** Who this agent reports to: the principal or another member. Absent on
   * the principal. */
  parentId?: string;
  /** Who started it: the person (the principal, or an agent added by hand)
   * or the principal through `delegate`. */
  createdBy: "user" | "agent";
  /** What it was asked to do (empty for a principal). The card's title is
   * the session's own title. */
  task: string;
  /** Named area of the canvas the agent was placed in, if any. */
  area?: string;
  /** What the agent is for, in one line, as the principal described it: how
   * it later tells which agent a new request fits. */
  purpose?: string;
  report?: RoomReport;
  stopped?: RoomStop;
  /** Epoch ms up to which this agent knows the room's context: when its
   * prompt (with the context index) was first built, then each time it was
   * told of items that arrived later. Absent until its first turn. */
  contextSeenAt?: number;
  /** Epoch ms when the agent's latest turn began (kept after it ends, so a
   * client can tell how long the agent worked). Absent until it first runs. */
  startedAt?: number;
  /** MCP servers (the person's connectors) the agent has called, in order
   * of first use. The relay's own bridges are not listed. */
  connectors?: string[];
  /** Worker only: messages (its task first) still to be delivered. */
  queuedMessages?: QueuedMessage[];
  /** Workers whose report has not been handed to this agent yet: the
   * outbox of the agent that started them (the principal, or a worker that
   * has agents under it). Persisted so a restart between a report and the
   * turn that delivers it loses nothing. */
  undeliveredReports?: string[];
}

/** Longest summary `report` accepts: the principal reads every one of them,
 * so a long one costs its context on every later turn. */
export const ROOM_REPORT_SUMMARY_MAX = 1000;
export const ROOM_REPORT_ARTIFACTS_MAX = 20;
export const ROOM_TASK_MAX = 20_000;
/** Longest name the principal may give an agent: it is the card's title. */
export const ROOM_AGENT_NAME_MAX = 60;
export const ROOM_AGENT_PURPOSE_MAX = 300;
/** Most connectors remembered per agent. */
export const ROOM_CONNECTORS_MAX = 30;
/** MCP servers that are the relay's own plumbing, not connectors. */
const OWN_MCP_SERVERS: ReadonlySet<string> = new Set(["anywh-choice", "anywh-room", "anywh-permission"]);

/** Whether an MCP server name is a connector of the person's (not one of the
 * relay's own bridges). */
export function isConnectorServer(server: string): boolean {
  return server !== "" && !OWN_MCP_SERVERS.has(server);
}
/** Messages waiting for one worker, and for a whole room. */
export const ROOM_QUEUE_PER_AGENT_MAX = 5;
export const ROOM_QUEUE_PER_ROOM_MAX = 20;

/** Live agents a room may have at once, the principal included. */
export const ROOM_MAX_LIVE_AGENTS = 10;

const ROLES: ReadonlySet<string> = new Set(["principal", "worker"]);
const REPORT_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "blocked"]);
const STOP_REASONS: ReadonlySet<string> = new Set(["user", "relay_restart", "removed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRoomReport(value: unknown): value is RoomReport {
  if (!isRecord(value)) return false;
  return (
    typeof value.status === "string" &&
    REPORT_STATUSES.has(value.status) &&
    typeof value.summary === "string" &&
    isStringList(value.artifacts) &&
    isTimestamp(value.at) &&
    (value.synthetic === undefined || typeof value.synthetic === "boolean")
  );
}

/** Runtime check for what the sessions file holds: a hand-edited,
 * truncated or future-schema record must never reach the room logic. */
export function isRoomMembership(value: unknown): value is RoomMembership {
  if (!isRecord(value)) return false;
  const { roomId, role, parentId, createdBy, task, area, purpose, report, stopped, undeliveredReports, queuedMessages, contextSeenAt, startedAt, connectors } = value;
  if (typeof roomId !== "string" || roomId === "") return false;
  if (typeof role !== "string" || !ROLES.has(role)) return false;
  if (createdBy !== "user" && createdBy !== "agent") return false;
  if (typeof task !== "string") return false;
  if (area !== undefined && typeof area !== "string") return false;
  if (purpose !== undefined && typeof purpose !== "string") return false;
  if (report !== undefined && !isRoomReport(report)) return false;
  if (contextSeenAt !== undefined && !isTimestamp(contextSeenAt)) return false;
  if (startedAt !== undefined && !isTimestamp(startedAt)) return false;
  if (connectors !== undefined && !(isStringList(connectors) && connectors.length <= ROOM_CONNECTORS_MAX)) return false;
  if (stopped !== undefined && !(isRecord(stopped) && typeof stopped.reason === "string" && STOP_REASONS.has(stopped.reason) && isTimestamp(stopped.at))) return false;
  if (role === "worker") {
    if (typeof parentId !== "string" || parentId === "") return false;
    if (undeliveredReports !== undefined && !isStringList(undeliveredReports)) return false;
    if (
      queuedMessages !== undefined &&
      !(Array.isArray(queuedMessages) && queuedMessages.length <= ROOM_QUEUE_PER_AGENT_MAX + 1 && queuedMessages.every((m) => isRecord(m) && typeof m.text === "string" && isTimestamp(m.at) && (m.reminder === undefined || m.reminder === true)))
    ) {
      return false;
    }
  } else {
    if (parentId !== undefined || queuedMessages !== undefined) return false;
    if (undeliveredReports !== undefined && !isStringList(undeliveredReports)) return false;
  }
  return true;
}

/** Where an agent of a room stands, as `room_status` and the room's channel
 * show it:
 * - `working`: a turn of it is running;
 * - `awaiting_user`: it asked the person something (a question or a tool
 *   approval) and its turn is over; nothing runs until they answer;
 * - `queued`: it has messages (its task, or one for it) not delivered yet;
 * - `waiting`: idle, never reported (only before its first turn ends);
 * - `done` / `blocked` / `failed`: its last report (a turn that failed or
 *   ended without a report gets one from the relay);
 * - `stopped`: the person stopped it.
 * Only `working` and `queued` take a place under the room's cap: an agent
 * that is idle, or waiting for the person, has nothing running for it. */
export type RoomAgentState = "working" | "awaiting_user" | "queued" | "waiting" | RoomReportStatus | "stopped";

export function roomAgentState(room: RoomMembership, busy: boolean, awaitingUser = false): RoomAgentState {
  if (room.stopped) return "stopped";
  if (busy) return "working";
  if (awaitingUser) return "awaiting_user";
  if ((room.queuedMessages?.length ?? 0) > 0) return "queued";
  return room.report?.status ?? "waiting";
}

export function takesRoomPlace(state: RoomAgentState): boolean {
  return state === "working" || state === "queued";
}

/** Whether `candidateId` is below `ancestorId` in the room's tree (direct
 * child or further down). `parentOf` answers each member's parent. Stops on
 * a cycle instead of looping. */
export function isDescendant(candidateId: string, ancestorId: string, parentOf: (id: string) => string | undefined): boolean {
  const seen = new Set<string>();
  let current = parentOf(candidateId);
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentOf(current);
  }
  return false;
}

/** Who a report from `workerId` goes to: the closest agent above it that is
 * still there and not stopped (an agent the person stopped or removed is not
 * going to read it), up to the principal. `undefined` when the chain ends
 * without one (the room is gone). Stops on a cycle. */
export function liveAncestorId(workerId: string, getRoom: (id: string) => RoomMembership | undefined): string | undefined {
  const seen = new Set<string>([workerId]);
  let current = getRoom(workerId)?.parentId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const room = getRoom(current);
    if (room && !room.stopped) return current;
    current = room?.parentId;
  }
  return undefined;
}

/** A short title for a worker's session out of its task: its first line,
 * cut at a word. */
export function titleFromTask(task: string, max = 60): string {
  const firstLine = task.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine || "Agent";
  const cut = firstLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** How an agent's caller names it: by id, by the start of its id (at least
 * eight characters, as ids get shortened in prose), or by its name (its
 * title), case and surrounding space ignored. `candidates` are the agents the
 * caller may address. A name two of them share answers `ambiguous`. */
export function resolveAgentRef(
  ref: string,
  candidates: readonly { id: string; title: string | null }[],
): { id: string } | { error: "unknown" } | { error: "ambiguous"; ids: string[] } {
  const wanted = ref.trim();
  const exact = candidates.find((candidate) => candidate.id === wanted);
  if (exact) return { id: exact.id };
  const key = wanted.toLocaleLowerCase();
  const named = candidates.filter((candidate) => candidate.title !== null && candidate.title.trim().toLocaleLowerCase() === key);
  if (named.length === 1) return { id: named[0].id };
  if (named.length > 1) return { error: "ambiguous", ids: named.map((candidate) => candidate.id) };
  if (wanted.length >= 8) {
    const prefixed = candidates.filter((candidate) => candidate.id.startsWith(wanted));
    if (prefixed.length === 1) return { id: prefixed[0].id };
  }
  return { error: "unknown" };
}

/** The room's areas as an agent should see them, and the area of each
 * agent. The canvas is the truth: the person draws, renames and fills areas
 * by hand, and a client places an agent in the canvas area whose label
 * matches its `area` (case and surrounding space ignored). An agent the
 * canvas does not hold yet (no client laid it out) is in the area it was
 * delegated to, if any. Areas with nobody in them are listed too: the person
 * may have drawn one for agents still to come. */
export function roomAreas(
  canvasAreas: readonly { label: string; members?: readonly string[] }[],
  agents: readonly { id: string; area?: string }[],
): { areas: { name: string; agentIds: string[] }[]; areaOf: Map<string, string> } {
  const key = (label: string): string => label.trim().toLowerCase();
  const known = new Set(agents.map((agent) => agent.id));
  const areas: { name: string; agentIds: string[] }[] = [];
  const byKey = new Map<string, { name: string; agentIds: string[] }>();
  const areaOf = new Map<string, string>();
  const areaNamed = (label: string): { name: string; agentIds: string[] } => {
    let area = byKey.get(key(label));
    if (!area) {
      area = { name: label.trim(), agentIds: [] };
      byKey.set(key(label), area);
      areas.push(area);
    }
    return area;
  };
  for (const canvasArea of canvasAreas) {
    if (canvasArea.label.trim() === "") continue;
    const area = areaNamed(canvasArea.label);
    for (const id of canvasArea.members ?? []) {
      if (!known.has(id) || areaOf.has(id)) continue;
      areaOf.set(id, area.name);
      area.agentIds.push(id);
    }
  }
  for (const agent of agents) {
    if (areaOf.has(agent.id) || !agent.area?.trim()) continue;
    const area = areaNamed(agent.area);
    areaOf.set(agent.id, area.name);
    area.agentIds.push(agent.id);
  }
  return { areas, areaOf };
}
