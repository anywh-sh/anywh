import type { SessionSummary } from "@/lib/relay/relay-types";
import { TICKET_KEY_PATTERN, type IntegrationProvider, type IntegrationState, type TicketRef, type TicketTag, type WorkTicket } from "@/lib/integrations/model";

/**
 * The tickets sessions work on, as the client reads them: what the relay's
 * integrations socket says (`work_tickets_state` and its updates), or — with
 * no such socket — what the session list carries. Pure.
 */

/** Every session's work ticket, by session id. */
export type WorkTicketMap = Record<string, WorkTicket>;

const PROVIDERS: readonly IntegrationProvider[] = ["jira", "linear"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A ticket as the relay accepts one in `startTicket`/`work_ticket`: a known
 * provider, a site, a well-formed key. What a tab persisted is read back
 * through this, so a hand-edited or outdated entry is dropped, not sent. */
export function isTicketRef(value: unknown): value is TicketRef {
  if (!isRecord(value)) return false;
  const { provider, site, key, id } = value;
  return (
    PROVIDERS.includes(provider as IntegrationProvider) &&
    typeof site === "string" &&
    site !== "" &&
    typeof key === "string" &&
    TICKET_KEY_PATTERN.test(key) &&
    (id === undefined || typeof id === "string")
  );
}

/** Just a ticket's provider and key, or `undefined` for anything else. */
export function ticketTagOf(value: unknown): TicketTag | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, key } = value;
  if (!PROVIDERS.includes(provider as IntegrationProvider) || typeof key !== "string" || !TICKET_KEY_PATTERN.test(key)) return undefined;
  return { provider: provider as IntegrationProvider, key };
}

export function isWorkTicket(value: unknown): value is WorkTicket {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId !== "" && isTicketRef(value.ticket) && typeof value.origin === "string";
}

export function sameTicket(a: TicketTag, b: TicketTag): boolean {
  return a.provider === b.provider && a.key === b.key;
}

/** The sessions that work on a ticket, the most recently linked first. */
export function linksOnTicket(links: WorkTicketMap | null, ticket: TicketTag): WorkTicket[] {
  if (!links) return [];
  return Object.values(links)
    .filter((link) => sameTicket(link.ticket, ticket))
    .sort((a, b) => b.linkedAt - a.linkedAt);
}

/** The ticket of one of the integration's rows, ready to be sent — `null`
 * until the relay knows the site it lives in. */
export function ticketRefFor(integration: IntegrationState, key: string): TicketRef | null {
  const site = integration.site?.id;
  if (!site) return null;
  return { provider: integration.provider, site, key };
}

/**
 * "Work on this in the current session" is offered when the tab beside the
 * pane is a session that exists on the relay and works on no ticket yet —
 * at most one ticket per session. `null` links (the relay has not said)
 * offers nothing: whether the session is free is unknown.
 */
export function canWorkHere(links: WorkTicketMap | null, sessionId: string | null): boolean {
  return links !== null && sessionId !== null && links[sessionId] === undefined;
}

/**
 * The ticket a session works on: the integrations socket's word when it has
 * spoken, otherwise the session list's (`fromList`).
 */
export function sessionTicket(links: WorkTicketMap | null, sessionId: string, fromList: TicketTag | undefined): (TicketTag & { title?: string }) | undefined {
  if (links === null) return fromList;
  const link = links[sessionId];
  if (!link) return undefined;
  return { provider: link.ticket.provider, key: link.ticket.key, ...(link.title ? { title: link.title } : {}) };
}

/** A row's chips: the first `max` sessions, and how many more there are. */
export function chipsOf<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** A session row with its `workTicket` kept only when well formed — the
 * sidebar draws the key, and the list is persisted. */
export function withValidWorkTicket<T extends SessionSummary>(session: T): T {
  if (session.workTicket === undefined) return session;
  const { workTicket, ...rest } = session;
  const tag = ticketTagOf(workTicket);
  return (tag ? { ...rest, workTicket: tag } : rest) as T;
}
