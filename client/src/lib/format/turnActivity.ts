import type { LogEntry } from "@/hooks/relay/useMessageLog";

/**
 * How many tools the agent has reached for since the user last spoke — what
 * the turn indicator reports while a turn is in flight.
 *
 * "Since the user last spoke" is the definition of the current turn that the
 * log can actually answer: tool-use entries carry no timestamp of their own,
 * so there is nothing to compare against the turn's start instant. Walking
 * back to the most recent user message gets the same answer without adding
 * a field to the wire format for a counter.
 *
 * Counts `tool-use`, not `tool-result`: a call that is still running is one
 * the user wants counted — that is precisely the one explaining the wait.
 */
export function countToolCallsInCurrentTurn(entries: LogEntry[]): number {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "user") break;
    if (entry.kind === "tool-use") count += 1;
  }
  return count;
}
