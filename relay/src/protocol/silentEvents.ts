import type { AgentEvent } from "./agent-event.js";

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
