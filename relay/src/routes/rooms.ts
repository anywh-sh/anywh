import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../protocol/httpBody.js";
import { parseRoomCanvas } from "../session/roomCanvas.js";
import type { RouteContext, RouteHandler } from "./context.js";

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
 * 404 for a room whose principal does not exist.
 */
export const handleRoomRoutes: RouteHandler = async (req, res, ctx) => {
  const url = new URL(req.url ?? "/", "http://relay");
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
  const roomId = decodeURIComponent(match[1]);
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
