// Plan usage on the wire: the `/plan-usage/watch` WebSocket the client keeps
// open per profile, and `GET /plan-usage`, the same snapshot over HTTP for
// debugging and the e2e tier. Everything else lives in planUsage/service.ts.
//
// The socket speaks only this vocabulary — relay → client
// `plan_usage_state` (on connect and on every change) and `pong`; client →
// relay `plan_usage_refresh` and `ping`. It never sends `protocol_version`:
// that is how the client tells it from an older relay, which has no such
// path and hands the socket to the chat handler, whose first message is
// `protocol_version` (client/src/lib/planUsage/watch.ts). Adding the path
// needs no WS_PROTOCOL_VERSION bump: no existing message changed.
//
// Liveness is client-initiated (`ping` → `pong`), never a server-side timer:
// the reply to a server ping is a frame towards the relay, which a paid
// host's idle detection counts as presence (same rule as /sessions/watch).
import type { WebSocket } from "ws";
import { isPingMessage, isPlanUsageRefreshMessage } from "../protocol/guards.js";
import type { PlanUsageService } from "../planUsage/service.js";
import type { RouteHandler } from "./context.js";

export const PLAN_USAGE_WATCH_PATH = "/plan-usage/watch";

// Diagnostic lines: which profile, what was asked, how many watchers. No
// address, no account data.
const PROFILE = process.env.ANYWH_PROFILE || "default";

export const handlePlanUsageRoutes: RouteHandler = (req, res, ctx) => {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/plan-usage") return Promise.resolve(false);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(ctx.planUsage.getSnapshot()));
  return Promise.resolve(true);
};

export function handlePlanUsageConnection(socket: WebSocket, service: PlanUsageService): void {
  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  // Subscribed before the snapshot is sent, so no change can fall between.
  const unsubscribe = service.subscribe(send);
  send(service.getSnapshot());
  const release = service.connectClient();
  console.log(`[plan-usage] watch opened (profile ${PROFILE}, clients ${service.connectedClients})`);

  socket.on("message", (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (isPingMessage(parsed)) {
      send({ type: "pong" });
      return;
    }
    if (isPlanUsageRefreshMessage(parsed)) {
      console.log(
        `[plan-usage] refresh (profile ${PROFILE}, runtime ${parsed.runtime ?? "all"}, force ${String(parsed.force)}, clients ${service.connectedClients})`,
      );
      // Answered with a snapshot when the reads end, even if nothing
      // changed: the client's spinner waits for one.
      service
        .refresh({ force: parsed.force, ...(parsed.runtime ? { runtime: parsed.runtime } : {}) })
        .catch((error: unknown) => console.error("[relay] plan usage refresh failed:", (error as Error).message))
        .finally(() => send(service.getSnapshot()));
    }
    // Anything else is ignored: an unknown command from a newer client.
  });

  socket.on("close", () => {
    unsubscribe();
    release();
    console.log(`[plan-usage] watch closed (profile ${PROFILE}, clients ${service.connectedClients})`);
  });
}
