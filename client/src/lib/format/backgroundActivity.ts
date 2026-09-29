import type { LogEntry } from "@/hooks/relay/useMessageLog";
import { relativeToCwd } from "@/lib/relay/toolCallSummary";

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

type ToolUseEntry = Extract<LogEntry, { kind: "tool-use" }>;

/** One line saying what a tool call is doing — `Bash npm test`,
 * `Read src/app.ts` — same "file path, else command, else the agent's own
 * description" choice `ToolCallCard`'s header makes, flattened onto a single
 * line for the background cards, which have no room for a card per call. */
export function toolCallLine(use: ToolUseEntry, cwd: string | null): string {
  const input = use.input;
  const detail =
    typeof input?.file_path === "string"
      ? relativeToCwd(input.file_path, cwd)
      : typeof input?.command === "string"
        ? input.command
        : typeof input?.pattern === "string"
          ? input.pattern
          : typeof input?.description === "string"
            ? input.description
            : "";
  const firstLine = detail.split("\n", 1)[0].trim();
  return firstLine ? `${use.name} ${firstLine}` : use.name;
}

/**
 * The last `limit` tool calls of the current turn, oldest first, as
 * `toolCallLine`s — what the background cards show as "what it's doing right
 * now". With `afterToolUseId`, only calls made after that one: a subagent's
 * own tool calls reach the log interleaved with the main thread's, with no
 * parent id on the wire, so "everything after the `Task` call that spawned
 * it" is the closest the log can get to "what the subagent is doing" — exact
 * for the usual case of one subagent at a time.
 */
export function recentToolCallLines(
  entries: LogEntry[],
  cwd: string | null,
  { limit, afterToolUseId }: { limit: number; afterToolUseId?: string },
): string[] {
  const lines: string[] = [];
  for (let i = entries.length - 1; i >= 0 && lines.length < limit; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "user") break;
    if (entry.kind !== "tool-use") continue;
    if (afterToolUseId !== undefined && entry.toolUseId === afterToolUseId) break;
    lines.push(toolCallLine(entry, cwd));
  }
  return lines.reverse();
}

/** Last `limit` non-empty lines of a job's log, with carriage-return progress
 * bars collapsed to their final state (`\r` rewrites the line in a terminal;
 * here it would otherwise show every intermediate frame glued together). */
export function logTailLines(tail: string, limit: number): string[] {
  return tail
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
    .filter((line) => line.trim() !== "")
    .slice(-limit);
}
