import { useEffect, useState } from "react";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";
import { markProfileRevoked } from "@/lib/profiles/profileRevocation";
import { parseRoomChannelMessage, type RoomAgent, type RoomSummary } from "@/lib/relay/roomClient";
import { trackStateSince } from "@/lib/sala/agentCard";
import type { RoomAgentState } from "@/lib/relay/roomClient";
import type { Profile } from "@/lib/profiles/profiles";

/** The relay closes the channel of a room that does not exist with this code. */
export const ROOM_GONE_CODE = 4404;
const RETRY_MS = 2_000;
const SLOW_RETRY_MS = 60_000;

export interface RoomChannelState {
  /** `connecting` until the first snapshot; `open` while the channel is up;
   * `reconnecting` after it dropped (the last known state stays on screen);
   * `gone` when the room no longer exists. */
  status: "connecting" | "open" | "reconnecting" | "gone";
  /** Principal first, as the relay lists them. */
  agents: RoomAgent[];
  summary: RoomSummary | null;
  /** When this screen first saw each agent in its present state. */
  since: ReadonlyMap<string, { state: RoomAgentState; since: number }>;
}

const INITIAL: RoomChannelState = { status: "connecting", agents: [], summary: null, since: new Map() };

/** Applies one frame of the room channel to what is known. Exported for the
 * tests: the merge rules are the part worth pinning down. */
export function reduceRoomChannel(state: RoomChannelState, frame: unknown, now: number): RoomChannelState {
  const message = parseRoomChannelMessage(frame);
  if (!message) return state;
  let agents = state.agents;
  let summary = state.summary;
  switch (message.type) {
    case "room_snapshot":
      agents = message.agents;
      summary = message.summary;
      break;
    case "room_agent_state": {
      const index = agents.findIndex((a) => a.agentId === message.agent.agentId);
      agents = index === -1 ? [...agents, message.agent] : agents.map((a, i) => (i === index ? message.agent : a));
      break;
    }
    case "room_agent_removed":
      agents = agents.filter((a) => a.agentId !== message.agentId);
      break;
    case "room_summary":
      summary = message.summary;
      break;
  }
  return { status: "open", agents, summary, since: trackStateSince(state.since, agents, now) };
}

/**
 * One socket for the whole room (`/rooms/:id/watch`): the first frame is
 * every agent, then only what changed. Reconnects on its own, keeping the
 * last known state on screen meanwhile; a room that is gone ends the loop.
 */
export function useRoomChannel(profile: Profile, roomId: string): RoomChannelState {
  const [state, setState] = useState<RoomChannelState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;
    let timer: number | undefined;

    function connect(wake: boolean): void {
      resolveConnection(profile, { wake })
        .then(({ host, port, token }) => {
          if (cancelled) return;
          const query = token ? `?token=${encodeURIComponent(token)}` : "";
          const ws = new WebSocket(`ws://${host}:${String(port)}/rooms/${encodeURIComponent(roomId)}/watch${query}`);
          socket = ws;
          ws.addEventListener("message", (event) => {
            let frame: unknown;
            try {
              frame = JSON.parse(event.data as string);
            } catch {
              return;
            }
            setState((prev) => reduceRoomChannel(prev, frame, Date.now()));
          });
          ws.addEventListener("close", (event) => {
            if (socket !== ws || cancelled) return;
            if (event.code === ROOM_GONE_CODE || event.reason === "room deleted") {
              setState((prev) => ({ ...prev, status: "gone" }));
              return;
            }
            setState((prev) => ({ ...prev, status: prev.status === "connecting" ? "connecting" : "reconnecting" }));
            timer = window.setTimeout(() => connect(false), RETRY_MS);
          });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (error instanceof BrokerRevokedError) {
            markProfileRevoked(profile.id);
            return;
          }
          const slow = error instanceof BrokerThrottledError || error instanceof BrokerAsleepError;
          setState((prev) => ({ ...prev, status: prev.status === "connecting" ? "connecting" : "reconnecting" }));
          timer = window.setTimeout(() => connect(wake), slow ? SLOW_RETRY_MS : RETRY_MS);
        });
    }
    connect(true);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      socket?.close();
    };
    // The profile object is rebuilt on edits that do not change where it
    // connects; what matters is the room and the profile's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, roomId]);

  return state;
}
