import type { LogEntry, SubagentState } from "@/hooks/relay/useMessageLog";
import type { ToolInput } from "@/lib/relay/agent-event";
import { relativeToCwd } from "@/lib/relay/toolCallSummary";

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** How many of a subagent's latest tool calls its card lists. */
const SUBAGENT_TOOL_CALLS_SHOWN = 6;

/** A subagent still at work, as the background cards show it. */
export interface RunningSubagent {
  /** The spawning `Agent`/`Task` call's id. */
  toolUseId: string;
  description: string | null;
  /** epoch ms — `null` when only the spawning call is known. */
  startedAt: number | null;
  /** What it is doing right now: the CLI's own one-line progress summary,
   * else its latest tool call. */
  activity: string | null;
  /** Its latest tool calls as `toolCallLine`s, oldest first. */
  toolCalls: string[];
  toolUses: number | null;
}

/**
 * Every subagent still running, oldest first — what the "AGENT" background
 * cards list.
 *
 * Read from the relay's `subagent` events (`SubagentState`), not from the
 * spawning tool call: `claude` names that call `Agent` (formerly `Task`), and
 * a `run_in_background` one returns "launched" immediately, so "call without a
 * result yet" says nothing about whether the subagent is still working.
 *
 * The one fallback is for a relay too old to send `subagent` events: an
 * `Agent`/`Task` call of the current turn with no result yet and no state of
 * its own still counts as running, with nothing more to say about it.
 */
export function runningSubagents(entries: LogEntry[], subagents: Record<string, SubagentState>, cwd: string | null): RunningSubagent[] {
  const running: RunningSubagent[] = Object.values(subagents)
    .filter((subagent) => subagent.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((subagent) => {
      const toolCalls = subagent.toolCalls.slice(-SUBAGENT_TOOL_CALLS_SHOWN).map((call) => toolCallLine(call, cwd));
      return {
        toolUseId: subagent.toolUseId,
        description: subagent.description ?? null,
        startedAt: subagent.startedAt,
        activity: subagent.activity ?? toolCalls[toolCalls.length - 1] ?? null,
        toolCalls,
        toolUses: subagent.toolUses ?? null,
      };
    });

  const answered = new Set(entries.flatMap((entry) => (entry.kind === "tool-result" && entry.toolUseId ? [entry.toolUseId] : [])));
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "user") break;
    if (entry.kind !== "tool-use" || !SUBAGENT_TOOLS.has(entry.name) || !entry.toolUseId) continue;
    if (answered.has(entry.toolUseId) || entry.toolUseId in subagents) continue;
    running.push({
      toolUseId: entry.toolUseId,
      description: typeof entry.input.description === "string" ? entry.input.description : null,
      startedAt: null,
      activity: null,
      toolCalls: [],
      toolUses: null,
    });
  }
  return running;
}


/** One line saying what a tool call is doing — `Bash npm test`,
 * `Read src/app.ts` — same "file path, else command, else the agent's own
 * description" choice `ToolCallCard`'s header makes, flattened onto a single
 * line for the background cards, which have no room for a card per call. */
export function toolCallLine(use: { name: string; input: ToolInput }, cwd: string | null): string {
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

/** The last `limit` tool calls of the current turn, oldest first, as
 * `toolCallLine`s — what the background cards show as "what it's doing right
 * now" for a turn running in another tab. A subagent's calls never reach
 * `entries` (see `SubagentState`), so these are the main agent's own. */
export function recentToolCallLines(entries: LogEntry[], cwd: string | null, { limit }: { limit: number }): string[] {
  const lines: string[] = [];
  for (let i = entries.length - 1; i >= 0 && lines.length < limit; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "user") break;
    if (entry.kind === "tool-use") lines.push(toolCallLine(entry, cwd));
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
