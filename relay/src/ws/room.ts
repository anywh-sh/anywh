import type { WebSocket } from "ws";
import type { RoomChannel } from "../session/roomChannel.js";

/**
 * `/rooms/:roomId/watch`: the whole room's state on one socket. First message
 * `room_snapshot` (every agent, with the totals), then `room_agent_state` /
 * `room_agent_removed` / `room_summary` for what changes. Read-only: the one
 * message it takes is the client's `ping`, answered with `pong` (a liveness
 * probe the client starts, never a timer here: see `/sessions/watch`).
 * Closes with 4404 for a room that does not exist.
 */
export function handleRoomWatchConnection(socket: WebSocket, roomId: string, channel: RoomChannel): void {
  if (!channel.watch(roomId, socket)) {
    socket.close(4404, "room not found");
    return;
  }
  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "ping") socket.send(JSON.stringify({ type: "pong" }));
  });
  socket.on("close", () => channel.unwatch(roomId, socket));
}
