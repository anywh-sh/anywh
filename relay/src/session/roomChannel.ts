// One channel per room for everything a room's screen needs: the state of all
// its agents (up to ten) on a single socket instead of one per session. The
// first message is the whole room; after that only what changed, coalesced so
// a burst of events (ten agents finishing together) is a handful of messages.
import type { WebSocket } from "ws";
import type { RoomAgentView, RoomSnapshot, RoomSummary } from "./roomState.js";

export interface RoomStateSource {
  snapshot(roomId: string): RoomSnapshot | undefined;
}

interface Watched {
  readonly sockets: Set<WebSocket>;
  /** What each agent looked like when it was last sent (as JSON). */
  sent: Map<string, string>;
  sentSummary: string;
  timer: NodeJS.Timeout | undefined;
}

export class RoomChannel {
  private readonly rooms = new Map<string, Watched>();

  constructor(
    private readonly source: RoomStateSource,
    private readonly coalesceMs = 30,
  ) {}

  /** Adds a watcher and sends it the whole room. `false` when there is no
   * such room. */
  watch(roomId: string, socket: WebSocket): boolean {
    const snapshot = this.source.snapshot(roomId);
    if (!snapshot) return false;
    let watched = this.rooms.get(roomId);
    if (!watched) {
      watched = { sockets: new Set(), sent: new Map(), sentSummary: "", timer: undefined };
      this.rooms.set(roomId, watched);
    }
    const first = watched.sockets.size === 0;
    watched.sockets.add(socket);
    if (first) this.remember(watched, snapshot);
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "room_snapshot", ...snapshot }));
    // Whatever changed between the baseline and this snapshot is in it.
    if (!first) this.remember(watched, snapshot);
    return true;
  }

  unwatch(roomId: string, socket: WebSocket): void {
    const watched = this.rooms.get(roomId);
    if (!watched) return;
    watched.sockets.delete(socket);
    if (watched.sockets.size === 0) {
      if (watched.timer) clearTimeout(watched.timer);
      this.rooms.delete(roomId);
    }
  }

  /** Something about the room changed: sends what differs, shortly. */
  touch(roomId: string): void {
    const watched = this.rooms.get(roomId);
    if (!watched || watched.timer) return;
    watched.timer = setTimeout(() => {
      watched.timer = undefined;
      this.flush(roomId, watched);
    }, this.coalesceMs);
    watched.timer.unref();
  }

  /** Closes every watcher of a room that no longer exists. */
  closeRoom(roomId: string): void {
    const watched = this.rooms.get(roomId);
    if (!watched) return;
    if (watched.timer) clearTimeout(watched.timer);
    this.rooms.delete(roomId);
    for (const socket of watched.sockets) socket.close(1000, "room deleted");
  }

  private remember(watched: Watched, snapshot: RoomSnapshot): void {
    watched.sent = new Map(snapshot.agents.map((agent) => [agent.agentId, JSON.stringify(agent)]));
    watched.sentSummary = JSON.stringify(snapshot.summary);
  }

  private flush(roomId: string, watched: Watched): void {
    const snapshot = this.source.snapshot(roomId);
    if (!snapshot) {
      this.closeRoom(roomId);
      return;
    }
    const messages: unknown[] = [];
    const seen = new Set<string>();
    for (const agent of snapshot.agents) {
      seen.add(agent.agentId);
      const json = JSON.stringify(agent);
      if (watched.sent.get(agent.agentId) === json) continue;
      watched.sent.set(agent.agentId, json);
      messages.push({ type: "room_agent_state", roomId, agent } satisfies { type: string; roomId: string; agent: RoomAgentView });
    }
    for (const agentId of [...watched.sent.keys()]) {
      if (seen.has(agentId)) continue;
      watched.sent.delete(agentId);
      messages.push({ type: "room_agent_removed", roomId, agentId });
    }
    const summaryJson = JSON.stringify(snapshot.summary);
    if (summaryJson !== watched.sentSummary) {
      watched.sentSummary = summaryJson;
      messages.push({ type: "room_summary", roomId, summary: snapshot.summary satisfies RoomSummary });
    }
    for (const message of messages) {
      const payload = JSON.stringify(message);
      for (const socket of watched.sockets) if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}
