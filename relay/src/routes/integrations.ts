// Integrations on the wire: the `/integrations/watch` WebSocket the client
// keeps open per profile, and `GET /integrations`, the same snapshot over
// HTTP for debugging and the e2e tier. Everything else lives in
// integrations/service.ts.
//
// Like `/plan-usage/watch`, the socket never sends `protocol_version`: an
// older relay has no such path and hands the socket to the chat handler,
// whose first message is `protocol_version` — that is how the client tells
// the two apart. Liveness is client-initiated (`ping` → `pong`), never a
// server-side timer (same rule as /sessions/watch).
import type { WebSocket } from "ws";
import { INTEGRATIONS_WATCH_PATH } from "../integrations/types.js";
import type { IntegrationService } from "../integrations/service.js";
import {
  isIntegrationAddMessage,
  isIntegrationLoadMoreMessage,
  isIntegrationPrefsMessage,
  isIntegrationRefreshMessage,
  isMcpAuthCancelMessage,
  isMcpAuthCompleteMessage,
  isMcpAuthRecheckMessage,
  isMcpAuthStartMessage,
  isPingMessage,
  isWorkTicketMessage,
} from "../protocol/guards.js";
import type { RouteHandler } from "./context.js";

export { INTEGRATIONS_WATCH_PATH };

// Diagnostic lines: which profile, what was asked, how many watchers. Never
// a ticket's content.
const PROFILE = process.env.ANYWH_PROFILE || "default";

export const handleIntegrationsRoutes: RouteHandler = (req, res, ctx) => {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/integrations") return Promise.resolve(false);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(ctx.integrations.getSnapshot()));
  return Promise.resolve(true);
};

export function handleIntegrationsConnection(socket: WebSocket, service: IntegrationService): void {
  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  // Subscribed before the snapshot is sent, so no change can fall between.
  const unsubscribe = service.subscribe(send);
  send(service.getSnapshot());
  const release = service.connectClient();
  console.log(`[integrations] watch opened (profile ${PROFILE}, clients ${service.connectedClients})`);

  // Answered with a snapshot when the read ends, even if nothing changed
  // (a refused or cached ask too): the client's spinner waits for one.
  const answer = (work: Promise<unknown>) => {
    work.catch((error: unknown) => console.error("[relay] integrations request failed:", (error as Error).message)).finally(() => send(service.getSnapshot()));
  };

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
    if (isIntegrationRefreshMessage(parsed)) {
      console.log(`[integrations] refresh (profile ${PROFILE}, ${parsed.id} ${parsed.query}, force ${String(parsed.force)})`);
      answer(service.refresh(parsed));
      return;
    }
    if (isIntegrationLoadMoreMessage(parsed)) {
      answer(service.loadMore(parsed));
      return;
    }
    if (isIntegrationPrefsMessage(parsed)) {
      if (!service.setPrefs(parsed.id, parsed.prefs)) send(service.getSnapshot());
      return;
    }
    if (
      isWorkTicketMessage(parsed) ||
      isMcpAuthStartMessage(parsed) ||
      isMcpAuthCompleteMessage(parsed) ||
      isMcpAuthCancelMessage(parsed) ||
      isMcpAuthRecheckMessage(parsed) ||
      isIntegrationAddMessage(parsed)
    ) {
      // Part of the vocabulary, not served by this relay yet.
      console.log(`[integrations] ${parsed.type} is not supported by this relay yet (profile ${PROFILE})`);
      return;
    }
    // Anything else is ignored: an unknown command from a newer client.
  });

  socket.on("close", () => {
    unsubscribe();
    release();
    console.log(`[integrations] watch closed (profile ${PROFILE}, clients ${service.connectedClients})`);
  });
}
