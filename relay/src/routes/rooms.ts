import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "../fs/uploads.js";
import { readJsonBody } from "../protocol/httpBody.js";
import { parseRoomCanvas } from "../session/roomCanvas.js";
import { CONTEXT_ITEM_MAX_BYTES } from "../session/roomContextStore.js";
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

/** A whole canvas can be far larger than other JSON bodies (its validator
 * allows ~1 MB of text). */
const MAX_CANVAS_BODY_BYTES = 1024 * 1024;

/** Reads a JSON body up to `limit`. Past it the rest is read and dropped, so
 * the answer (413) still reaches the client instead of a cut connection. */
function readLimitedJson(req: IncomingMessage, limit: number): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > limit) {
        resolve({ tooLarge: true });
        return;
      }
      try {
        resolve({ tooLarge: false, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

async function handleCanvas(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, roomId: string): Promise<void> {
  if (req.method === "GET") {
    send(res, 200, { canvas: ctx.roomCanvas.get(roomId) });
    return;
  }
  let body: unknown;
  try {
    const read = await readLimitedJson(req, MAX_CANVAS_BODY_BYTES);
    if (read.tooLarge) {
      send(res, 413, { error: `canvas body too large (limit ${MAX_CANVAS_BODY_BYTES} bytes)` });
      return;
    }
    body = read.value;
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

/** `/rooms/:roomId/context[/:name]`: the room's shared files and their index. */
async function handleContext(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, roomId: string, name: string | undefined): Promise<void> {
  try {
    await handleContextNow(req, res, ctx, roomId, name);
  } catch (error) {
    // The folder is one agents can write to: a file they made unreadable is
    // an answer, not a crash of every session on this relay.
    console.warn(`[relay] room context of ${roomId}: ${(error as Error).message}`);
    if (!res.headersSent) send(res, 500, { error: "the room's context folder could not be read or written" });
  }
}

async function handleContextNow(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, roomId: string, name: string | undefined): Promise<void> {
  const { roomContext } = ctx;
  if (req.method === "GET" && name === undefined) {
    const items = await roomContext.list(roomId);
    send(res, 200, { dir: roomContext.dirFor(roomId), items, index: await roomContext.index(roomId) });
    return;
  }
  if (req.method === "POST" && name === undefined) {
    const url = new URL(req.url ?? "/", "http://relay");
    const fileName = url.searchParams.get("name");
    if (!fileName) {
      send(res, 400, { error: "name is required" });
      return;
    }
    let data: Buffer;
    try {
      data = await readRawBody(req, CONTEXT_ITEM_MAX_BYTES);
    } catch {
      send(res, 413, { error: `the file is larger than ${CONTEXT_ITEM_MAX_BYTES} bytes` });
      return;
    }
    const added = await roomContext.add(roomId, { name: fileName, data, author: "user" });
    if (added.ok) send(res, 201, { item: added.item, ...(added.warning ? { warning: added.warning } : {}) });
    else send(res, added.status, { error: added.error });
    return;
  }
  if (req.method === "DELETE" && name !== undefined) {
    if (await roomContext.remove(roomId, name)) send(res, 200, { removed: true });
    else send(res, 404, { error: "no such item in this room's context" });
    return;
  }
  send(res, 405, { error: "method not allowed" });
}

/**
 * Rooms over HTTP:
 *   POST /rooms                  opens a room: `{ agentId?, model?, effort?,
 *                                permissionMode?, cwd?, title?, firstMessage? }`
 *                                (`firstMessage` goes to the principal as if
 *                                typed in its session) for its
 *                                principal → `201 { roomId }` (the principal's
 *                                session id: chat with it like any session)
 *   GET  /rooms/:roomId          the room's agents (principal first), each with
 *                                the cache it read and wrote (`usage`)
 *   GET  /rooms/:roomId/canvas   the room's canvas (layout only)
 *   PUT  /rooms/:roomId/canvas   replaces it: `{ canvas }`, validated whole
 *   GET  /rooms/:roomId/agents/:agentId/subtasks
 *                                that agent's native subagents (its subtasks)
 *   POST /rooms/:roomId/agents  the person starts a worker: `{ task, agentId?,
 *                                model?, effort?, parentId? }` → `201 { agentId }`
 *                                (the principal is the parent by default; the
 *                                model defaults to the principal's when the
 *                                agent is the same; 409 when the room is full)
 *   GET  /rooms/:roomId/worktrees
 *                                every worktree the room's agents created,
 *                                retained ones too, with their size →
 *                                `{ worktrees, totalSizeBytes }`
 *   POST /rooms/:roomId/agents/:agentId/subtasks/:taskId/stop
 *                                stops one of them, leaving the agent running
 *   POST /rooms/:roomId/agents/:agentId/stop
 *                                stops one worker (its turn and its process in
 *                                the agent host), the others go on; it no
 *                                longer counts under the room's cap
 *   POST /rooms/:roomId/agents/:agentId/resume
 *                                lets a stopped worker take turns again
 *   POST /rooms/:roomId/agents/:agentId/remove
 *                                removes a worker and the agents below it:
 *                                stopped and hidden now, deleted for good
 *                                after `undoMs` → `{ removed: [ids], undoMs }`.
 *                                Body `{ discard?: true }`: without it, work in
 *                                worktrees that is not integrated stops the
 *                                removal (409 `{ error, needsDiscard: true,
 *                                worktrees }`, nothing removed); with it, those
 *                                worktrees are discarded once the undo window
 *                                is over
 *   POST /rooms/:roomId/agents/:agentId/restore
 *                                undoes a removal within that window
 *   GET  /rooms/:roomId/context  the room's shared files, their index, and
 *                                the folder agents read them from
 *   POST /rooms/:roomId/context?name=<file>
 *                                adds the raw request body as an item
 *                                (extracted to text when it is a PDF)
 *   DELETE /rooms/:roomId/context/:name
 *                                removes an item: its file, its extraction,
 *                                its line of the index
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
  const lifecycle = /^\/rooms\/([^/]+)\/agents\/([^/]+)\/(remove|restore)$/.exec(url.pathname);
  if (lifecycle && req.method === "POST") {
    const [roomId, agentId] = [decode(lifecycle[1]), decode(lifecycle[2])];
    if (roomId === undefined || agentId === undefined) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    if (lifecycle[3] === "remove") {
      let discard = false;
      try {
        const body = await readJsonBody(req);
        discard = typeof body === "object" && body !== null && (body as { discard?: unknown }).discard === true;
      } catch {
        // No body (or none worth reading) is a removal without discarding.
      }
      const outcome = await ctx.roomManager.removeAgent(roomId, agentId, { discard });
      if (outcome.ok) send(res, 200, { removed: outcome.removed, undoMs: outcome.undoMs });
      else send(res, outcome.status, { error: outcome.error, ...(outcome.needsDiscard ? { needsDiscard: true, worktrees: outcome.worktrees } : {}) });
    } else {
      const outcome = ctx.roomManager.restoreAgent(roomId, agentId);
      if (outcome.ok) send(res, 200, { restored: outcome.restored });
      else send(res, outcome.status, { error: outcome.error });
    }
    return true;
  }
  const launch = /^\/rooms\/([^/]+)\/agents$/.exec(url.pathname);
  if (launch && req.method === "POST") {
    const roomId = decode(launch[1]);
    if (roomId === undefined) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      send(res, 400, { error: "invalid body" });
      return true;
    }
    const outcome = ctx.roomManager.launchByPerson(roomId, body);
    if (outcome.ok) send(res, 201, { agentId: outcome.agentId });
    else send(res, outcome.status, { error: outcome.error });
    return true;
  }
  const worktreesRoute = /^\/rooms\/([^/]+)\/worktrees$/.exec(url.pathname);
  if (worktreesRoute && req.method === "GET") {
    const roomId = decode(worktreesRoute[1]);
    if (roomId === undefined) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    if (!roomExists(ctx, roomId)) {
      send(res, 404, { error: "room not found" });
      return true;
    }
    const worktrees = await ctx.roomManager.worktreesOf(roomId, { size: true });
    send(res, 200, { worktrees, totalSizeBytes: worktrees.reduce((sum, tree) => sum + (tree.sizeBytes ?? 0), 0) });
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
    if (outcome.ok) send(res, 200, stopAgent[3] === "stop" ? { stopped: true } : { resumed: true });
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
  const contextRoute = /^\/rooms\/([^/]+)\/context(?:\/([^/]+))?$/.exec(url.pathname);
  if (contextRoute) {
    const [roomId, name] = [decode(contextRoute[1]), contextRoute[2] === undefined ? undefined : decode(contextRoute[2])];
    if (roomId === undefined || (contextRoute[2] !== undefined && name === undefined)) {
      send(res, 400, { error: "malformed path" });
      return true;
    }
    if (!roomExists(ctx, roomId)) {
      send(res, 404, { error: "room not found" });
      return true;
    }
    await handleContext(req, res, ctx, roomId, name);
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
    // Removed agents wait out their undo window out of sight.
    .filter(({ room }) => room.stopped?.reason !== "removed")
    .sort((a, b) => (a.room.role === b.room.role ? 0 : a.room.role === "principal" ? -1 : 1))
    .map(({ id, room }) => {
      const agentId = ctx.sessionStore.getAgentId(id);
      return { id, title: ctx.sessionStore.getTitle(id), agentId, model: ctx.sessionStore.getModel(id, agentId) ?? null, room, usage: ctx.roomUsage.get(id) };
    });
  send(res, 200, { roomId, members });
  return true;
};
