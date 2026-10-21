import type { AgentEvent, HistoryMessage } from "@/lib/relay/relayClient";

/**
 * What the side panel of a room worker shows of its conversation: the latest
 * assistant text of the agent's last turn, not the whole transcript.
 */
export interface AgentReply {
  /** The latest assistant text of the last turn: the block being written when
   * one is streaming, else the last block the turn committed. `""` until the
   * turn writes anything. */
  text: string;
  /** A turn is in flight. */
  running: boolean;
  /** Why the last turn failed, `null` when it did not. */
  error: string | null;
  /** How many turns the stream has shown. The first one is the agent's task,
   * which its report already summarizes. */
  turns: number;
  /** Text blocks of the turn that are still streaming, by index. */
  streaming: Record<string, string>;
}

export const emptyReply: AgentReply = { text: "", running: false, error: null, turns: 0, streaming: {} };

/** The last block still streaming (insertion order is the order they opened). */
function lastStreaming(streaming: Record<string, string>): string {
  const keys = Object.keys(streaming);
  return keys.length === 0 ? "" : streaming[keys[keys.length - 1]];
}

/**
 * Folds one event of the agent's stream into its reply. `turn_ended` and
 * `error` are events like any other here: the live socket hands them over as
 * separate callbacks, and the hook turns them back into events so a replayed
 * history and a live stream take this one path.
 */
export function applyReplyEvent(state: AgentReply, event: AgentEvent): AgentReply {
  if (event.type === "turn_started") return { text: "", running: true, error: null, turns: state.turns + 1, streaming: {} };
  if (event.type === "text_delta") {
    const key = String(event.index);
    const streaming = { ...state.streaming, [key]: (state.streaming[key] ?? "") + event.text };
    return { ...state, streaming, text: lastStreaming(streaming) };
  }
  if (event.type === "text") {
    // A subagent's prose is not the agent's reply; the CLI's interruption
    // marker is not prose at all.
    if (event.parentToolUseId !== undefined || event.text.startsWith("[Request interrupted")) return state;
    return { ...state, text: event.text, streaming: {} };
  }
  if (event.type === "turn_ended") {
    // A stop can cut the stream before the block was committed.
    const partial = lastStreaming(state.streaming);
    return { ...state, running: false, text: partial !== "" ? partial : state.text, streaming: {} };
  }
  if (event.type === "error") return { ...state, running: false, error: event.message, streaming: {} };
  return state;
}

/** Replays a session's history (the page the relay sends on connect). */
export function replyFromHistory(messages: readonly HistoryMessage[]): AgentReply {
  let reply = emptyReply;
  for (const message of messages) reply = applyReplyEvent(reply, message.event);
  return reply;
}

/**
 * Whether the panel has anything to put under the message field. The task
 * turn (the agent's first) is left out once it is over and the agent has
 * reported: the report section already says what it concluded, and showing
 * the same words twice reads as a bug. While it runs, or when it failed, it
 * shows.
 */
export function shouldShowReply(reply: AgentReply, hasReport: boolean): boolean {
  if (reply.running || reply.error !== null) return true;
  if (reply.text.trim() === "") return false;
  return !(reply.turns <= 1 && hasReport);
}
