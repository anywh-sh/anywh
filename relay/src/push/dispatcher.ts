import { randomUUID } from "node:crypto";
import type { SessionPushEvent } from "../session/sessionManager.js";
import { groupByGateway, interpretResponse, MAX_ATTEMPTS, nextDelayMs, type GatewayTarget } from "./delivery.js";
import type { PushStore } from "./pushStore.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface PushDispatcherOptions {
  store: PushStore;
  // The seams below exist for the dispatcher's own tests (a local gateway,
  // a clock that does not wait); the relay uses the defaults.
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  schedule?: (run: () => void, delayMs: number) => void;
  newEventId?: () => string;
  log?: (line: string) => void;
}

/**
 * Sends a session's notification-worthy moments to the gateways its
 * registered devices point at (docs/push.md, contract C). The relay never
 * learns what a gateway does with them: it posts the event and the keys,
 * forgets the keys a gateway says are dead, and retries the ones it says
 * failed. Best effort by design — the queue lives in memory and a restart
 * drops whatever was waiting to retry.
 *
 * Nothing is logged but the event id, its kind, the gateway's origin and
 * counts: titles and previews are the user's text and stay out of logs.
 */
export class PushDispatcher {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (run: () => void, delayMs: number) => void;
  private readonly newEventId: () => string;
  private readonly log: (line: string) => void;

  constructor(private readonly options: PushDispatcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.schedule =
      options.schedule ??
      ((run, delayMs) => {
        // Unref'd: a retry waiting out a backoff must not keep a relay
        // that is shutting down alive.
        setTimeout(run, delayMs).unref();
      });
    this.newEventId = options.newEventId ?? randomUUID;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Fire and forget — a turn never waits on a notification. */
  notify(event: SessionPushEvent): void {
    // Someone is looking at this session: they already see it, and so does
    // everybody else's phone — one person at the screen silences the rest.
    if (event.watched) return;
    const devices = this.options.store.all();
    if (devices.length === 0) return;

    const eventId = this.newEventId();
    const wire = {
      v: 1,
      eventId,
      event: { kind: event.kind, sessionId: event.sessionId, title: event.title, preview: event.preview, ts: event.ts },
    };
    for (const [gatewayUrl, targets] of groupByGateway(devices)) {
      void this.attempt(gatewayUrl, wire, event.kind, targets, 1);
    }
  }

  private async attempt(gatewayUrl: string, wire: object, kind: string, targets: GatewayTarget[], attempt: number): Promise<void> {
    const eventId = (wire as { eventId: string }).eventId;
    const where = originOf(gatewayUrl);
    let status: number | null = null;
    let body: unknown;
    let retryAfter: string | null = null;
    try {
      const response = await this.fetchImpl(gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wire, devices: targets }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A gateway that redirects is not one to follow: the body is a
        // person's text and goes only where it was registered.
        redirect: "manual",
      });
      status = response.status;
      retryAfter = response.headers.get("retry-after");
      body = await response.json().catch(() => undefined);
    } catch {
      // No answer at all: a refused connection, a timeout, a DNS failure.
      // Treated as retryable; the cause adds nothing a log line could act on.
    }

    const outcome = interpretResponse(status, body, retryAfter, this.now());
    if (outcome.kind === "drop") {
      this.log(`[relay] push ${eventId} ${kind} -> ${where}: dropped (${outcome.reason})`);
      return;
    }
    if (outcome.kind === "retry") {
      this.retryOrGiveUp(gatewayUrl, wire, kind, targets, attempt, outcome.afterMs, status === null ? "unreachable" : `status ${status}`);
      return;
    }

    if (outcome.rejected.length > 0) this.options.store.removeByPushKeys(outcome.rejected);
    this.log(
      `[relay] push ${eventId} ${kind} -> ${where}: ${targets.length - outcome.rejected.length - outcome.failed.length} delivered, ${outcome.rejected.length} rejected, ${outcome.failed.length} failed`,
    );
    if (outcome.failed.length > 0) {
      const failed = new Set(outcome.failed);
      this.retryOrGiveUp(gatewayUrl, wire, kind, targets.filter((t) => failed.has(t.pushKey)), attempt, undefined, "failed keys");
    }
  }

  private retryOrGiveUp(gatewayUrl: string, wire: object, kind: string, targets: GatewayTarget[], attempt: number, afterMs: number | undefined, why: string): void {
    const eventId = (wire as { eventId: string }).eventId;
    if (attempt >= MAX_ATTEMPTS) {
      this.log(`[relay] push ${eventId} ${kind} -> ${originOf(gatewayUrl)}: giving up after ${attempt} attempts (${why})`);
      return;
    }
    this.schedule(() => void this.attempt(gatewayUrl, wire, kind, targets, attempt + 1), nextDelayMs(attempt, this.random(), afterMs));
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}
