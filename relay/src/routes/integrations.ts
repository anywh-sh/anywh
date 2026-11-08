// Integrations on the wire: the `/integrations/watch` WebSocket the client
// keeps open per profile, and `GET /integrations`, the same snapshot over
// HTTP for debugging and the e2e tier. Everything else lives in
// integrations/service.ts, and each session's work ticket in
// integrations/ticketLinks.ts.
//
// Like `/plan-usage/watch`, the socket never sends `protocol_version`: an
// older relay has no such path and hands the socket to the chat handler,
// whose first message is `protocol_version` — that is how the client tells
// the two apart. Liveness is client-initiated (`ping` → `pong`), never a
// server-side timer (same rule as /sessions/watch).
import type { WebSocket } from "ws";
import { INTEGRATIONS_WATCH_PATH } from "../integrations/types.js";
import type { IntegrationService } from "../integrations/service.js";
import type { TicketLinks } from "../integrations/ticketLinks.js";
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

export function handleIntegrationsConnection(socket: WebSocket, service: IntegrationService, links: TicketLinks): void {
  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  // Subscribed before the snapshots are sent, so no change can fall between.
  const unsubscribe = service.subscribe(send);
  const unsubscribeLinks = links.subscribe(send);
  const auth = service.auth;
  const unsubscribeAuth = auth?.subscribe((flow) => send({ type: "mcp_auth_flow", ...flow }));
  send(service.getSnapshot());
  send({ type: "work_tickets_state", links: links.list() });
  // The sign-ins in progress (and the latest finished), so a device that
  // connects mid-flow shows its card.
  for (const flow of auth?.flows() ?? []) send({ type: "mcp_auth_flow", ...flow });
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
    if (isWorkTicketMessage(parsed)) {
      const { sessionId } = parsed;
      if (parsed.action === "unlink") {
        // Without a link there is nothing to undo: still ok.
        links.unlink(sessionId);
        send({ type: "work_ticket_result", sessionId, ok: true });
        return;
      }
      const title = service.ticketTitle(parsed.ticket.provider, parsed.ticket.key);
      // The person attached it: their next message tells the agent.
      const result = links.link(sessionId, parsed.ticket, "manual", { lineDue: true, ...(title ? { title } : {}) });
      console.log(`[integrations] work ticket link (profile ${PROFILE}, ${result})`);
      send(result === "ok" ? { type: "work_ticket_result", sessionId, ok: true } : { type: "work_ticket_result", sessionId, error: result });
      return;
    }
    if (isMcpAuthStartMessage(parsed)) {
      console.log(`[integrations] sign-in asked (profile ${PROFILE}, ${parsed.targets.map((target) => `${target.runtimeId}/${target.serverName}`).join(", ")})`);
      auth?.start(parsed.targets, parsed.mode ?? "deeplink");
      return;
    }
    if (isMcpAuthCompleteMessage(parsed)) {
      const outcome = auth?.complete(parsed.flowId, parsed.callbackUrl) ?? "unknown_flow";
      // A refused callback leaves the flow waiting; its card says why.
      if (outcome !== "ok") console.log(`[integrations] sign-in callback refused (profile ${PROFILE}, ${outcome})`);
      return;
    }
    if (isMcpAuthCancelMessage(parsed)) {
      auth?.cancel(parsed.flowId);
      return;
    }
    if (isMcpAuthRecheckMessage(parsed)) {
      auth?.recheck(parsed.flowId);
      return;
    }
    if (isIntegrationAddMessage(parsed)) {
      console.log(`[integrations] add (profile ${PROFILE}, ${parsed.id} on ${parsed.runtimes.join(", ")})`);
      const { id } = parsed;
      service
        .addIntegration(id, parsed.runtimes, (runtimeId, result) => {
          const failure = result.failures.find((candidate) => candidate.runtimeId === runtimeId);
          if (failure) {
            console.log(`[integrations] add on ${runtimeId} failed (profile ${PROFILE}): ${failure.error}`);
            send({ type: "integration_add_result", id, runtimeId, error: failure.error });
            return;
          }
          const target = result.targets.find((candidate) => candidate.runtimeId === runtimeId);
          send({ type: "integration_add_result", id, runtimeId, ok: true, ...(target ? { serverName: target.serverName } : {}) });
        })
        .catch((error: unknown) => console.error("[relay] integration add failed:", (error as Error).message))
        .finally(() => send(service.getSnapshot()));
      return;
    }
    // Anything else is ignored: an unknown command from a newer client.
  });

  socket.on("close", () => {
    unsubscribe();
    unsubscribeLinks();
    unsubscribeAuth?.();
    release();
    console.log(`[integrations] watch closed (profile ${PROFILE}, clients ${service.connectedClients})`);
  });
}
