import type { LogEntry } from "@/hooks/relay/useMessageLog";

export interface RunningTaskCall {
  toolUseId: string;
  description: string | null;
}

/**
 * The most recent `Task` (subagent delegation) tool call in the current turn
 * that hasn't gotten its `tool-result` back yet — `undefined` once the
 * result arrives or the turn moves on.
 *
 * This is deliberately the only signal the "AGENTE" background card reads:
 * the protocol carries no step/progress data for a subagent's own work, no
 * model name, and no token count for it (Claude's CLI filters `usage` to the
 * main thread only) — see `countToolCallsInCurrentTurn` for the same
 * "walk back to the last user message" current-turn boundary this reuses.
 */
export function findRunningTaskCall(entries: LogEntry[]): RunningTaskCall | undefined {
  const answeredToolUseIds = new Set(
    entries
      .filter((entry): entry is Extract<LogEntry, { kind: "tool-result" }> => entry.kind === "tool-result")
      .map((entry) => entry.toolUseId)
      .filter((id): id is string => id !== undefined),
  );
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "user") break;
    if (entry.kind !== "tool-use" || entry.name !== "Task" || !entry.toolUseId) continue;
    if (answeredToolUseIds.has(entry.toolUseId)) continue;
    return { toolUseId: entry.toolUseId, description: entry.input.description ?? null };
  }
  return undefined;
}
