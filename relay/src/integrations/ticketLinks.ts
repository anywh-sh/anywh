// The ticket each session works on: at most one per session (a ticket can
// have several sessions). A link is made by starting a session from a
// ticket, by the person attaching one to a session that has none, or by the
// agent opening one through the tracker's MCP server while its session has
// none; the person removes it. A session that already has a ticket refuses
// another (`conflict`) — it is never replaced behind the person's back.
//
// Kept beside the profile's sessions file (`<profile>-ticket-links.json`),
// `{version, bySession}` keyed by session, so "one per session" holds by
// construction; the sessions of a ticket are the reverse lookup. A link
// whose session no longer exists is dropped on load, and a deleted
// session's link goes with it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TICKET_KEY_PATTERN, type IntegrationProvider, type IntegrationsServerMessage, type TicketRef, type WorkTicket, type WorkTicketOrigin, type WorkTicketPlace } from "./types.js";

export const TICKET_LINKS_FILE_VERSION = 1;

/** Next to the profile's sessions file, like the integrations file. */
export function ticketLinksPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-ticket-links.json` : `${sessionsFile}-ticket-links.json`;
}

export interface TicketLinksStore {
  /** `undefined` when there is no file, or one this relay cannot read. */
  load(): Record<string, WorkTicket> | undefined;
  save(bySession: Record<string, WorkTicket>): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";
const PROVIDERS: readonly IntegrationProvider[] = ["jira", "linear"];
const ORIGINS: readonly WorkTicketOrigin[] = ["start", "manual", "mcp", "delegate"];

function restoreTicket(raw: unknown): TicketRef | undefined {
  if (!isRecord(raw)) return undefined;
  const { provider, site, key, id } = raw;
  if (!PROVIDERS.includes(provider as IntegrationProvider) || !isNonEmptyString(site) || typeof key !== "string" || !TICKET_KEY_PATTERN.test(key)) return undefined;
  return { provider: provider as IntegrationProvider, site, key, ...(isNonEmptyString(id) ? { id } : {}) };
}

function restorePlace(raw: unknown): WorkTicketPlace | undefined {
  if (!isRecord(raw)) return undefined;
  const { roomId, roomTitle, agentTitle, agentState } = raw;
  if (!isNonEmptyString(roomId) || typeof roomTitle !== "string" || typeof agentTitle !== "string" || typeof agentState !== "string") return undefined;
  return { roomId, roomTitle, agentTitle, agentState };
}

function restoreLink(sessionId: string, raw: unknown): WorkTicket | undefined {
  if (!isRecord(raw)) return undefined;
  const ticket = restoreTicket(raw.ticket);
  const origin = raw.origin as WorkTicketOrigin;
  if (!ticket || !ORIGINS.includes(origin) || typeof raw.linkedAt !== "number" || !Number.isFinite(raw.linkedAt)) return undefined;
  const place = restorePlace(raw.place);
  return {
    sessionId,
    ticket,
    origin,
    ...(place ? { place } : {}),
    ...(isNonEmptyString(raw.evidence) ? { evidence: raw.evidence } : {}),
    linkedAt: raw.linkedAt,
    ...(isNonEmptyString(raw.title) ? { title: raw.title } : {}),
    lineDue: raw.lineDue === true,
  };
}

/** The file's text as this relay reads it; `undefined` for another version
 * or something that is not this file. Every link is re-checked. */
export function parseTicketLinksFile(text: string): Record<string, WorkTicket> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== TICKET_LINKS_FILE_VERSION || !isRecord(parsed.bySession)) return undefined;
  const bySession: Record<string, WorkTicket> = {};
  for (const [sessionId, raw] of Object.entries(parsed.bySession)) {
    const link = restoreLink(sessionId, raw);
    if (link) bySession[sessionId] = link;
  }
  return bySession;
}

export function createFileTicketLinksStore(path: string): TicketLinksStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      return parseTicketLinksFile(text);
    },
    save(bySession) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: TICKET_LINKS_FILE_VERSION, bySession }), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export type TicketLinkEvent = Extract<IntegrationsServerMessage, { type: "work_ticket_upsert" | "work_ticket_removed" }>;
export type TicketLinkResult = "ok" | "conflict" | "no_session";

export interface TicketLinksOptions {
  readonly store?: TicketLinksStore;
  /** Whether a session exists; a link to one that does not is refused, and
   * dropped on load. Every session counts when absent. */
  readonly sessionExists?: (sessionId: string) => boolean;
  /** Whether a session may have a ticket at all (a room's principal, which
   * orchestrates several agents, may not): a link to one that may not is
   * refused as a `conflict`. Every session may when absent. */
  readonly mayHold?: (sessionId: string) => boolean;
  readonly now?: () => number;
}

export interface LinkDetails {
  readonly title?: string;
  /** The tool that made an `mcp` link. */
  readonly evidence?: string;
  /** The person's next message tells the agent (see `takeDueLine`). */
  readonly lineDue?: boolean;
  readonly place?: WorkTicketPlace;
}

export class TicketLinks {
  private readonly bySession = new Map<string, WorkTicket>();
  private readonly listeners = new Set<(event: TicketLinkEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: TicketLinksOptions = {}) {
    this.now = options.now ?? Date.now;
    const stored = options.store?.load() ?? {};
    let dropped = false;
    for (const [sessionId, link] of Object.entries(stored)) {
      if (options.sessionExists && !options.sessionExists(sessionId)) {
        dropped = true;
        continue;
      }
      this.bySession.set(sessionId, link);
    }
    if (dropped) this.persist();
  }

  get(sessionId: string): WorkTicket | undefined {
    const link = this.bySession.get(sessionId);
    return link ? copy(link) : undefined;
  }

  list(): WorkTicket[] {
    return [...this.bySession.values()].map(copy);
  }

  /** Called with every link made, changed or removed. */
  subscribe(listener: (event: TicketLinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Gives `sessionId` its ticket, unless it already has one. */
  link(sessionId: string, ticket: TicketRef, origin: WorkTicketOrigin, details: LinkDetails = {}): TicketLinkResult {
    if (this.options.sessionExists && !this.options.sessionExists(sessionId)) return "no_session";
    if (this.bySession.has(sessionId) || (this.options.mayHold && !this.options.mayHold(sessionId))) return "conflict";
    const link: WorkTicket = {
      sessionId,
      ticket: { provider: ticket.provider, site: ticket.site, key: ticket.key, ...(ticket.id !== undefined ? { id: ticket.id } : {}) },
      origin,
      ...(details.place ? { place: { ...details.place } } : {}),
      ...(details.evidence ? { evidence: details.evidence } : {}),
      linkedAt: this.now(),
      ...(details.title ? { title: details.title } : {}),
      lineDue: details.lineDue === true,
    };
    this.bySession.set(sessionId, link);
    this.persist();
    this.emit({ type: "work_ticket_upsert", link: copy(link) });
    return "ok";
  }

  /** Takes the ticket off `sessionId`. `false` when it had none. */
  unlink(sessionId: string): boolean {
    if (!this.bySession.delete(sessionId)) return false;
    this.persist();
    this.emit({ type: "work_ticket_removed", sessionId });
    return true;
  }

  /** Where the room agent of `sessionId` sits and how it is doing, for the
   * ticket's screen; announced only when it changed. A session without a
   * link is left alone. */
  setPlace(sessionId: string, place: WorkTicketPlace | undefined): void {
    const link = this.bySession.get(sessionId);
    if (!link || JSON.stringify(link.place) === JSON.stringify(place)) return;
    if (place) link.place = { ...place };
    else delete link.place;
    this.persist();
    this.emit({ type: "work_ticket_upsert", link: copy(link) });
  }

  /** The ticket the agent of `sessionId` has not been told about yet, once:
   * the caller puts it in the prompt it is about to send. */
  takeDueLine(sessionId: string): TicketRef | undefined {
    const link = this.bySession.get(sessionId);
    if (!link?.lineDue) return undefined;
    link.lineDue = false;
    this.persist();
    this.emit({ type: "work_ticket_upsert", link: copy(link) });
    return { ...link.ticket };
  }

  /** The agent of `sessionId` lost what it was told (its conversation was
   * cleared or rewound): the person's next message tells it again. */
  rearmLine(sessionId: string): void {
    const link = this.bySession.get(sessionId);
    if (!link || link.lineDue) return;
    link.lineDue = true;
    this.persist();
    this.emit({ type: "work_ticket_upsert", link: copy(link) });
  }

  private emit(event: TicketLinkEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A subscriber's failure is its own.
        console.error("[relay] ticket link listener failed:", error);
      }
    }
  }

  private persist(): void {
    if (!this.options.store) return;
    try {
      this.options.store.save(Object.fromEntries(this.bySession));
    } catch (error) {
      console.error("[relay] could not save the ticket links:", (error as Error).message);
    }
  }
}

function copy(link: WorkTicket): WorkTicket {
  return { ...link, ticket: { ...link.ticket }, ...(link.place ? { place: { ...link.place } } : {}) };
}
