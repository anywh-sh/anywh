import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../protocol/httpBody.js";
import { parseRoomCanvas } from "../session/roomCanvas.js";
import type { RouteContext, RouteHandler } from "./context.js";

/** `undefined` for a malformed escape, which is answered rather than thrown. */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(body));
}

/** The room `roomId` names, as long as its principal exists. */
function roomExists(ctx: RouteContext, roomId: string): boolean {
  const room = ctx.sessionStore.getRoom(roomId);
  return room?.role === "principal" && room.roomId === roomId;
}

async function handleCanvas(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, roomId: string): Promise<void> {
  if (req.method === "GET") {
    send(res, 200, { canvas: ctx.roomCanvas.get(roomId) });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    send(res, 400, { error: "invalid body" });
    return;
  }
  const canvas = parseRoomCanvas((body as { canvas?: unknown } | null)?.canvas);
  if (!canvas) {
    send(res, 400, { error: "canvas is malformed" });
    return;
  }
  ctx.roomCanvas.set(roomId, canvas);
  send(res, 200, { canvas });
}

/**
 * Rooms over HTTP:
 *   POST /rooms                  opens a room: `{ agentId?, model?, effort?,
 *                                permissionMode?, cwd?, title? }` for its
 *                                principal → `201 { roomId }` (the principal's
 *                                session id: chat with it like any session)
 *   GET  /rooms/:roomId          the room's agents (principal first)
 *   GET  /rooms/:roomId/canvas   the room's canvas (layout only)
 *   PUT  /rooms/:roomId/canvas   replaces it: `{ canvas }`, validated whole
 *   GET  /rooms/:roomId/agents/:agentId/subtasks
 *                                that agent's native subagents (its subtasks)
 *   POST /rooms/:roomId/agents/:agentId/subtasks/:taskId/stop
 *                                stops one of them, leaving the agent running
 *   POST /rooms/:roomId/agents/:agentId/stop
 *                                stops one worker (its turn and its process in
 *                                the agent host), the others go on; it no
 *                                longer counts under the room's cap
 *   POST /rooms/:roomId/agents/:agentId/resume
 *                                lets a stopped worker take turns again
 * 404 for a room whose principal does not exist.
 */
/** `/rooms/:roomId/agents/:agentId/subtasks[/:taskId/stop]`: a member's
 * native subagents, and stopping one. */
async function handleSubtasks(res: ServerResponse, ctx: RouteContext, roomId: string, agentId: string, stopTaskId: string | undefined): Promise<void> {
  const member = ctx.sessionStore.getRoom(agentId);
  if (!roomExists(ctx, roomId) || member?.roomId !== roomId) {
    send(res, 404, { error: "no such agent in this room" });
    return;
  }
  const session = ctx.sessionManager.getOrCreate(agentId);
  if (stopTaskId === undefined) {
    send(res, 200, { subtasks: session.listSubtasks() });
    return;
  }
  let outcome: Awaited<ReturnType<typeof session.stopSubtask>>;
  try {
    outcome = await session.stopSubtask(stopTaskId);
  } catch (error) {
    send(res, 503, { error: `the agent host could not stop it: ${(error as Error).message}` });
    return;
  }
  if (outcome === "stopping") send(res, 200, { stopping: true });
  else if (outcome === "unknown") send(res, 404, { error: "no running subtask with that id" });
  else send(res, 409, { error: "this agent's runtime has no subtasks to stop" });
}

export const handleRoomRoutes: RouteHandler = async (req, res, ctx) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const subtasks = /^\/rooms\/([^/]+)\/agents\/([^/]+)\/subtasks(?:\/([^/]+)\/stop)?$/.exec(url.pathname);
  if (subtasks) {
    if ((subtasks[3] === undefined && req.method !== "GET") || (subtasks[3] !== undefined && req.method !== "POST")) return false;
    const [roomId, agentId] = [decode(subtasks[1]), decode(subtasks[2])];
    const stopTaskId = subtasks[3] === undefined ? undefined : decode(subtasks[3]);
    if (roomId === undefined || agentId === undefined || (subtasks[3] !== undefined && stopTaskId === undefined)) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    await handleSubtasks(res, ctx, roomId, agentId, stopTaskId);
    return true;
  }
  const stopAgent = /^\/rooms\/([^/]+)\/agents\/([^/]+)\/(stop|resume)$/.exec(url.pathname);
  if (stopAgent && req.method === "POST") {
    const [roomId, agentId] = [decode(stopAgent[1]), decode(stopAgent[2])];
    if (roomId === undefined || agentId === undefined) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    const outcome = stopAgent[3] === "stop" ? await ctx.roomManager.stopAgent(roomId, agentId) : ctx.roomManager.resumeAgent(roomId, agentId);
    if (outcome.ok) send(res, 200, { stopped: true });
    else send(res, outcome.status, { error: outcome.error });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/rooms") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: "invalid body" });
      return true;
    }
    const created = ctx.roomManager.createRoom(typeof body === "object" && body !== null ? body : {});
    if (created.ok) send(res, 201, { roomId: created.roomId });
    else send(res, 400, { error: created.error });
    return true;
  }
  const match = /^\/rooms\/([^/]+)(\/canvas)?$/.exec(url.pathname);
  if (!match) return false;
  const roomId = decode(match[1]);
  if (roomId === undefined) {
    send(res, 400, { error: "malformed path" });
    return true;
  }
  const isCanvas = match[2] !== undefined;
  if (req.method !== "GET" && !(isCanvas && req.method === "PUT")) return false;
  if (!roomExists(ctx, roomId)) {
    send(res, 404, { error: "room not found" });
    return true;
  }
  if (isCanvas) {
    await handleCanvas(req, res, ctx, roomId);
    return true;
  }
  const members = ctx.sessionStore
    .listRoomMembers(roomId)
    .sort((a, b) => (a.room.role === b.room.role ? 0 : a.room.role === "principal" ? -1 : 1))
    .map(({ id, room }) => {
      const agentId = ctx.sessionStore.getAgentId(id);
      return { id, title: ctx.sessionStore.getTitle(id), agentId, model: ctx.sessionStore.getModel(id, agentId) ?? null, room };
    });
  send(res, 200, { roomId, members });
  return true;
};
