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
  report?: RoomReport;
  stopped?: RoomStop;
  /** Worker only: messages (its task first) still to be delivered. */
  queuedMessages?: QueuedMessage[];
  /** Principal only: workers whose report has not been handed to the
   * principal yet. Persisted so a restart between a report and the turn
   * that delivers it loses nothing. */
  undeliveredReports?: string[];
}

/** Longest summary `report` accepts: the principal reads every one of them,
 * so a long one costs its context on every later turn. */
export const ROOM_REPORT_SUMMARY_MAX = 1000;
export const ROOM_REPORT_ARTIFACTS_MAX = 20;
export const ROOM_TASK_MAX = 20_000;
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
  const { roomId, role, parentId, createdBy, task, area, report, stopped, undeliveredReports, queuedMessages } = value;
  if (typeof roomId !== "string" || roomId === "") return false;
  if (typeof role !== "string" || !ROLES.has(role)) return false;
  if (createdBy !== "user" && createdBy !== "agent") return false;
  if (typeof task !== "string") return false;
  if (area !== undefined && typeof area !== "string") return false;
  if (report !== undefined && !isRoomReport(report)) return false;
  if (stopped !== undefined && !(isRecord(stopped) && typeof stopped.reason === "string" && STOP_REASONS.has(stopped.reason) && isTimestamp(stopped.at))) return false;
  if (role === "worker") {
    if (typeof parentId !== "string" || parentId === "") return false;
    if (undeliveredReports !== undefined) return false;
    if (
      queuedMessages !== undefined &&
      !(Array.isArray(queuedMessages) && queuedMessages.length <= ROOM_QUEUE_PER_AGENT_MAX + 1 && queuedMessages.every((m) => isRecord(m) && typeof m.text === "string" && isTimestamp(m.at)))
    ) {
      return false;
    }
  } else {
    if (parentId !== undefined || queuedMessages !== undefined) return false;
    if (undeliveredReports !== undefined && !isStringList(undeliveredReports)) return false;
  }
  return true;
}

/** Where an agent of a room stands, as `room_status` shows it:
 * - `working`: a turn of it is running;
 * - `queued`: it has messages (its task, or one for it) not delivered yet;
 * - `waiting`: idle, never reported (only before its first turn ends);
 * - `done` / `blocked` / `failed`: its last report (a turn that failed or
 *   ended without a report gets one from the relay);
 * - `stopped`: the person stopped it.
 * Only `working` and `queued` take a place under the room's cap: an agent
 * that is idle has nothing running for it. */
export type RoomAgentState = "working" | "queued" | "waiting" | RoomReportStatus | "stopped";

export function roomAgentState(room: RoomMembership, busy: boolean): RoomAgentState {
  if (room.stopped) return "stopped";
  if (busy) return "working";
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

/** A short title for a worker's session out of its task: its first line,
 * cut at a word. */
export function titleFromTask(task: string, max = 60): string {
  const firstLine = task.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine || "Agent";
  const cut = firstLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
