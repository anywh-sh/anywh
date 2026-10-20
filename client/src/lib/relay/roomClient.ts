import type { Profile } from "@/lib/profiles/profiles";
import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";

// Client for a room's HTTP surface and its channel (see the relay's
// `routes/rooms.ts` and `session/roomChannel.ts`). The shapes mirror the
// relay's by convention, not by import — same as the rest of `lib/relay`.

/** Where an agent of a room stands; the relay derives it from what is
 * persisted plus whether a turn is running. */
export type RoomAgentState = "working" | "awaiting_user" | "queued" | "waiting" | "done" | "blocked" | "failed" | "stopped";

export const ROOM_AGENT_STATES: readonly RoomAgentState[] = ["working", "awaiting_user", "queued", "waiting", "done", "blocked", "failed", "stopped"];

export interface RoomNeedsYou {
  kind: "approval" | "choice";
  promptId: string;
  /** Epoch ms the person was first asked; absent for an old record. */
  askedAt?: number;
  count: number;
}

export interface RoomReportView {
  status: "done" | "failed" | "blocked";
  summary: string;
  artifacts: string[];
  at: number;
  fromRelay?: boolean;
}

export interface RoomAgent {
  agentId: string;
  role: "principal" | "worker";
  parentId?: string;
  title: string | null;
  runtime: string;
  model: string | null;
  area?: string;
  createdBy: "user" | "agent";
  state: RoomAgentState;
  queuedMessages: number;
  report?: RoomReportView;
  needsYou: RoomNeedsYou[];
  subtasksRunning: number;
  /** Epoch ms the agent's latest turn began; absent if it never ran. */
  startedAt?: number;
  /** MCP servers the agent has called, in order of first use. */
  connectors: string[];
}

export interface RoomSummary {
  counts: Record<RoomAgentState, number>;
  needsYou: number;
  live: number;
  liveLimit: number;
}

export type RoomChannelMessage =
  | { type: "room_snapshot"; roomId: string; agents: RoomAgent[]; summary: RoomSummary }
  | { type: "room_agent_state"; roomId: string; agent: RoomAgent }
  | { type: "room_agent_removed"; roomId: string; agentId: string }
  | { type: "room_summary"; roomId: string; summary: RoomSummary };

export interface RoomCanvasPoint {
  x: number;
  y: number;
}

export interface RoomCanvasArea {
  id: string;
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  members?: string[];
}

export interface RoomCanvasText {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface RoomCanvasCamera {
  x: number;
  y: number;
  zoom: number;
}

/** What the relay keeps of a room's layout (presentation only). */
export interface RoomCanvas {
  positions: Record<string, RoomCanvasPoint>;
  areas: RoomCanvasArea[];
  texts: RoomCanvasText[];
  camera?: RoomCanvasCamera;
  /** The person arranged something by hand: the layout stops being redone
   * for the whole room and only newcomers are placed. */
  manual?: boolean;
}

export interface CreateRoomInput {
  agentId?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  cwd?: string;
  title?: string;
  /** Delivered to the principal by the relay itself, so it is not lost
   * between two sockets. */
  firstMessage?: string;
}

async function call(profile: Profile, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const { host, port, token } = await resolveConnection(profile);
  return fetch(`http://${host}:${String(port)}${path}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }), ...authHeaders(token) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** A refusal by the relay, with the status it came with: a retry is worth it
 * for a server error and pointless for a request the relay called malformed. */
export class RoomRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RoomRequestError";
  }
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new RoomRequestError(body.error ?? `${what} (${String(response.status)})`, response.status);
}

/** Opens a room: the returned id is its principal's session id. */
export async function createRoom(profile: Profile, input: CreateRoomInput): Promise<string> {
  const response = await call(profile, "/rooms", { method: "POST", body: input });
  if (!response.ok) throw await failure(response, "failed to open the room");
  return ((await response.json()) as { roomId: string }).roomId;
}

/** `null` when the relay has no such room (404): the caller decides what a
 * room that is gone means for its tab. */
export async function fetchRoomCanvas(profile: Profile, roomId: string): Promise<RoomCanvas | null> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/canvas`);
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response, "failed to load the canvas");
  return ((await response.json()) as { canvas: RoomCanvas }).canvas;
}

export async function saveRoomCanvas(profile: Profile, roomId: string, canvas: RoomCanvas): Promise<void> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/canvas`, { method: "PUT", body: { canvas } });
  if (!response.ok) throw await failure(response, "failed to save the canvas");
}

/** How many items the room's shared context holds. */
export async function fetchRoomContextCount(profile: Profile, roomId: string): Promise<number> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/context`);
  if (!response.ok) throw await failure(response, "failed to read the room's context");
  return ((await response.json()) as { items: unknown[] }).items.length;
}

/** Adds a file to the room's shared context. */
export async function addRoomContextFile(profile: Profile, roomId: string, file: File): Promise<void> {
  const { host, port, token } = await resolveConnection(profile);
  const response = await fetch(`http://${host}:${String(port)}/rooms/${encodeURIComponent(roomId)}/context?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: authHeaders(token),
    body: file,
  });
  if (!response.ok) throw await failure(response, "failed to add the file");
}

export interface RemovedAgents {
  removed: string[];
  undoMs: number;
}

export async function stopRoomAgent(profile: Profile, roomId: string, agentId: string): Promise<void> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/stop`, { method: "POST" });
  if (!response.ok) throw await failure(response, "failed to stop the agent");
}

/** What a worktree of an agent looks like (`GET /rooms/:id/worktrees`). */
export interface RoomWorktree {
  id: string;
  agentId: string;
  repoRoot: string;
  path: string;
  branch: string;
  state: string;
  phase: "in_use" | "idle";
  commitsAhead?: number;
  clean?: boolean;
  integrated: boolean;
  retainedReason?: string;
  sizeBytes?: number;
}

/** The relay refused to remove an agent whose work is not integrated until
 * the person confirms: `worktrees` is what would be lost. */
export class DiscardNeededError extends RoomRequestError {
  constructor(
    message: string,
    readonly worktrees: RoomWorktree[],
  ) {
    super(message, 409);
    this.name = "DiscardNeededError";
  }
}

export async function removeRoomAgent(profile: Profile, roomId: string, agentId: string, options: { discard?: boolean } = {}): Promise<RemovedAgents> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/remove`, {
    method: "POST",
    body: options.discard ? { discard: true } : {},
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; needsDiscard?: boolean; worktrees?: RoomWorktree[] };
    if (body.needsDiscard) throw new DiscardNeededError(body.error ?? "the agent has work that is not integrated", body.worktrees ?? []);
    throw new RoomRequestError(body.error ?? "failed to remove the agent (409)", 409);
  }
  if (!response.ok) throw await failure(response, "failed to remove the agent");
  return (await response.json()) as RemovedAgents;
}

export interface LaunchAgentInput {
  task: string;
  agentId?: string;
  model?: string;
  effort?: string;
  parentId?: string;
}

/** The person starts a worker of the room; resolves with its id. */
export async function launchRoomAgent(profile: Profile, roomId: string, input: LaunchAgentInput): Promise<string> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents`, { method: "POST", body: input });
  if (!response.ok) throw await failure(response, "failed to start the agent");
  return ((await response.json()) as { agentId: string }).agentId;
}

export interface RoomWorktrees {
  worktrees: RoomWorktree[];
  totalSizeBytes: number;
}

export async function fetchRoomWorktrees(profile: Profile, roomId: string): Promise<RoomWorktrees> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/worktrees`);
  if (!response.ok) throw await failure(response, "failed to list the worktrees");
  return (await response.json()) as RoomWorktrees;
}

/** The agent's subtasks (native subagents) and stopping one. */
export interface RoomSubtask {
  taskId: string;
  toolUseId: string;
  status: "running" | "completed" | "failed" | "stopped";
  background: boolean;
  description?: string;
  subagentType?: string;
  activity?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export async function fetchAgentSubtasks(profile: Profile, roomId: string, agentId: string): Promise<RoomSubtask[]> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/subtasks`);
  if (!response.ok) throw await failure(response, "failed to list the subtasks");
  return ((await response.json()) as { subtasks: RoomSubtask[] }).subtasks;
}

export async function stopAgentSubtask(profile: Profile, roomId: string, agentId: string, taskId: string): Promise<void> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/subtasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
  if (!response.ok) throw await failure(response, "failed to stop the subtask");
}

export async function restoreRoomAgent(profile: Profile, roomId: string, agentId: string): Promise<void> {
  const response = await call(profile, `/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/restore`, { method: "POST" });
  if (!response.ok) throw await failure(response, "failed to restore the agent");
}

/** Narrows a parsed frame from the room channel; anything else is ignored. */
export function parseRoomChannelMessage(value: unknown): RoomChannelMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as { type?: unknown };
  switch (message.type) {
    case "room_snapshot":
    case "room_agent_state":
    case "room_agent_removed":
    case "room_summary":
      return value as RoomChannelMessage;
    default:
      return null;
  }
}

/** Hands the room's first message to its principal. Opens the principal's
 * session socket once, waits for the history replay to end (`caught_up`),
 * sends the text, and closes shortly after — the room's own screen shows
 * what the principal does with it. Resolves `true` when the message went. */
export async function sendFirstRoomMessage(profile: Profile, roomId: string, text: string): Promise<boolean> {
  const { host, port, token } = await resolveConnection(profile);
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws://${host}:${String(port)}/?session=${encodeURIComponent(roomId)}${tokenParam}`);
    let sent = false;
    const giveUp = window.setTimeout(() => socket.close(), 15_000);
    socket.addEventListener("message", (event) => {
      if (sent) return;
      try {
        const parsed = JSON.parse(event.data as string) as { type?: string };
        if (parsed.type !== "caught_up") return;
      } catch {
        return;
      }
      sent = true;
      socket.send(JSON.stringify({ type: "user_message", text }));
      // The relay reads the frame before it reads the close that follows.
      window.setTimeout(() => socket.close(), 400);
    });
    socket.addEventListener("close", () => {
      window.clearTimeout(giveUp);
      resolve(sent);
    });
    socket.addEventListener("error", () => socket.close());
  });
}
