import type { AgentEvent } from "./agent-event.js";

/** Sentinel the model answers with, and nothing else, when a finished
 * background job needs no report. Only honoured by the relay when the prompt
 * of that turn offered it (see `SILENCE_OFFER_MARKER`). */
export const NO_REPLY = "NO_REPLY";

/** Phrase that appears in a background-job prompt if, and only if, it offers
 * the `NO_REPLY` escape. Lives here (not in `session/turnMessages.ts`) so the
 * transcript reader can recognise an offered prompt on replay without
 * importing from `session/`. Matched after the log fence, so a log that
 * happens to contain the word cannot fake an offer. */
export const SILENCE_OFFER_MARKER = `responda exatamente ${NO_REPLY} e nada mais`;

/** The same offer worded in English, for the prompts the relay writes in
 * English (a room's digest). Recognised wherever `SILENCE_OFFER_MARKER` is. */
export const NO_REPLY_OFFER_EN = `answer exactly ${NO_REPLY} and nothing else`;

/** First line of a room's digest prompt: how a transcript read back later
 * tells one from a message the person typed. */
export const ROOM_DIGEST_PREFIX = "[anywh-room]";

/** Whether `text` is the model answering `NO_REPLY` and nothing else:
 * trimmed, with wrapping backticks/quotes and a trailing period tolerated. */
export function isNoReply(text: string): boolean {
  return text.trim().replace(/^[`"']+|[`"'.]+$/g, "").trim() === NO_REPLY;
}

/** Whether a background-job prompt (as sent to the model, or read back from
 * a transcript) offered the `NO_REPLY` escape. */
export function promptOffersSilence(prompt: string): boolean {
  const afterLog = prompt.slice(prompt.lastIndexOf("```") + 3);
  return afterLog.includes(SILENCE_OFFER_MARKER) || afterLog.includes(NO_REPLY_OFFER_EN);
}

/**
 * Relay-internal marker for events that belong to a silenced turn (an
 * automatic background-job report the model answered with `NO_REPLY`).
 *
 * The turn stays in `SharedSession.history` as a minimal `user_message` +
 * `turn_ended` pair, because message editing counts turns in `history`
 * against the `user` lines of the on-disk transcript: dropping the turn would
 * make the two disagree. Only the send path (replay to a connecting or
 * scrolling client) filters marked events out.
 *
 * Kept as an identity-keyed set instead of a field on `AgentEvent` so nothing
 * changes on the wire: the event objects are what travel from a transcript
 * reader, through a driver, into `history`, and the object identity survives
 * that whole path. A client never sees (or needs to know about) the marker.
 */
const silentEvents = new WeakSet<AgentEvent>();

export function markSilent(event: AgentEvent): AgentEvent {
  silentEvents.add(event);
  return event;
}

export function isSilentEvent(event: AgentEvent): boolean {
  return silentEvents.has(event);
}
