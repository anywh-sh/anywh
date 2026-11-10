// The tickets a person's message referenced with the composer's `#` chip:
// display only, so its bubble draws them as chips again — live on every
// device, and after a reload or a relay restart. The model never sees them;
// its prompt carries just the keys, in the text.
//
// A message read back from the agent's transcript has no id of its own, so
// a session keeps its refs keyed by the message's text and which occurrence
// of that text it is among the session's user messages; a ref whose key the
// text no longer has is dropped.
import type { AgentEvent, MessageTicketRef } from "../protocol/agent-event.js";
import type { BroadcastMessage } from "./broadcast.js";
import { TICKET_KEY_PATTERN } from "../integrations/types.js";

/** The refs of one message, as the session keeps them. `occurrence` is
 * 0-based: the first message with this text is 0. */
export interface StoredTicketRefs {
  text: string;
  occurrence: number;
  refs: MessageTicketRef[];
}

/** How many messages a session keeps refs for; the oldest go first. */
export const STORED_TICKET_REFS_LIMIT = 200;

type UserMessageEvent = Extract<AgentEvent, { type: "user_message" }>;

/** The text a message is matched by, live and replayed alike. */
function textKey(text: string): string {
  return text.trim();
}

/** A message a person typed: no synthetic turn, no room card. */
function isPersonMessage(event: AgentEvent): event is UserMessageEvent {
  return event.type === "user_message" && event.synthetic === undefined && event.room === undefined;
}

/** Whether `key` stands in `text` as a whole key (`NGL-12` is not in `NGL-123`). */
export function textHasKey(text: string, key: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(key, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + key.length] ?? "";
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) return true;
    from = at + 1;
  }
}

/** The refs a text still has, once per key. */
export function refsInText(refs: readonly MessageTicketRef[], text: string): MessageTicketRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.key) || !textHasKey(text, ref.key)) return false;
    seen.add(ref.key);
    return true;
  });
}

/** How many person messages with `text` the history already has: the
 * occurrence a new one with it will be. */
export function nextOccurrence(history: readonly BroadcastMessage[], text: string): number {
  const key = textKey(text);
  let count = 0;
  for (const message of history) if (isPersonMessage(message.event) && textKey(message.event.text) === key) count++;
  return count;
}

/** `stored` with one more message's refs, capped. */
export function withStoredRefs(stored: readonly StoredTicketRefs[], text: string, occurrence: number, refs: MessageTicketRef[]): StoredTicketRefs[] {
  const key = textKey(text);
  const rest = stored.filter((entry) => entry.text !== key || entry.occurrence !== occurrence);
  return [...rest, { text: key, occurrence, refs }].slice(-STORED_TICKET_REFS_LIMIT);
}

/** The events read back from the agent's storage, with each person message
 * that had refs carrying them again. Pure; untouched without stored refs. */
export function attachTicketRefs(events: AgentEvent[], stored: readonly StoredTicketRefs[]): AgentEvent[] {
  if (stored.length === 0) return events;
  const byMessage = new Map(stored.map((entry) => [`${String(entry.occurrence)}\n${entry.text}`, entry.refs]));
  const seen = new Map<string, number>();
  return events.map((event) => {
    if (!isPersonMessage(event)) return event;
    const key = textKey(event.text);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    const refs = byMessage.get(`${String(occurrence)}\n${key}`);
    const kept = refs ? refsInText(refs, event.text) : [];
    return kept.length > 0 ? { ...event, ticketRefs: kept } : event;
  });
}

const PROVIDERS: readonly string[] = ["jira", "linear"];

function restoreRef(raw: unknown): MessageTicketRef | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { provider, site, key, title } = raw as Record<string, unknown>;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider) || typeof site !== "string" || typeof key !== "string" || !TICKET_KEY_PATTERN.test(key)) return undefined;
  return { provider: provider as MessageTicketRef["provider"], site, key, ...(typeof title === "string" && title !== "" ? { title } : {}) };
}

/** What a sessions file holds for one session, re-checked: anything not
 * shaped like stored refs is dropped. */
export function restoreStoredTicketRefs(raw: unknown): StoredTicketRefs[] {
  if (!Array.isArray(raw)) return [];
  const restored: StoredTicketRefs[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { text, occurrence, refs } = entry as Record<string, unknown>;
    if (typeof text !== "string" || typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0 || !Array.isArray(refs)) continue;
    const kept = (refs as unknown[]).map(restoreRef).filter((ref): ref is MessageTicketRef => ref !== undefined);
    if (kept.length > 0) restored.push({ text, occurrence, refs: kept });
  }
  return restored.slice(-STORED_TICKET_REFS_LIMIT);
}
