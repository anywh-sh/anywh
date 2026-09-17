import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isToolResultOnly, type ClaudeEvent } from "./session.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";
import type { AgentEvent } from "../../../protocol/agent-event.js";

/** Same shape as `session/broadcast.ts`'s `BroadcastMessage` — defined here
 * independently (rather than imported) so this file has no reason to reach
 * into `session/` at all. The two are structurally identical, so
 * `SharedSession` accepts this return value directly. */
export interface HistoryEntry {
  type: "agent_event";
  event: AgentEvent;
}

/**
 * A line of the `.jsonl` that Claude Code writes on its own at
 * `~/.claude/projects/<project>/<session_id>.jsonl` — loosely typed on
 * purpose (it's its own internal transcript, not a protocol of ours, and it
 * has line types we've never documented: `queue-operation`, `attachment`,
 * `last-prompt`, `mode`, `ai-title`, `permission-mode`, `agent-name`,
 * `pr-link`, `file-history-*`...). Only the fields we actually use are
 * typed; the rest is ignored by design.
 */
export interface TranscriptLine {
  type: string;
  isMeta?: boolean;
  message?: { content?: unknown };
  [key: string]: unknown;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * Extracts the text of a genuine human message — a direct string, or a list
 * with at least one text block. `undefined` when the record isn't that:
 * `tool_result` feedback (agentic loop, not typed by anyone) or `isMeta`
 * noise (reminders/caveats injected by Claude Code itself).
 *
 * Exported — `transcriptFork.ts` uses the same criterion to count
 * turns when deciding where to cut the file during message editing.
 */
export function extractHumanText(line: TranscriptLine): string | undefined {
  if (line.isMeta) return undefined;
  const content = line.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && !isToolResultOnly(content)) {
    const textBlocks = content.filter(isTextBlock);
    if (textBlocks.length > 0) return textBlocks.map((block) => block.text).join("\n");
  }
  return undefined;
}

/**
 * Replaces any character outside `[a-zA-Z0-9-]` with `-` — same
 * sanitization Claude Code uses for the folder name in
 * `~/.claude/projects/`. Confirmed by checking against real folders from
 * both profiles: `/home/user/personal/anywh/relay` -> `-home-user-personal-anywh-relay`,
 * `/home/user/.anywh-trabalho-home` -> `-home-user--anywh-trabalho-home`.
 */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** The Claude Code CLI derives the folder name from the process's real
 * `cwd` (`process.cwd()`, which the kernel already returns without symlink
 * components) — sanitizing the raw `cwd` without resolving the symlink
 * first makes this calculation land on a folder that doesn't exist whenever
 * some path component is a symlink (real finding: `~/.anywh-trabalho-home/mode`
 * -> `~/mode`, sessions in the `widgets` repo computed
 * `-home-user--anywh-trabalho-home-mode-widgets` instead of the real folder,
 * `-home-user-mode-widgets`). Falls back to the raw `cwd` if the path no longer
 * exists (test/fixture session, or a deleted folder) — same behavior as
 * before in that case, just without trying to resolve what can't be
 * resolved. */
function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Exported only for testing — lets the test write the fixture in the same
 * place the real code will look, instead of duplicating the sanitization
 * rule. `home` and `cwd` already come resolved by the caller
 * (`SharedSession`, via `paths.ts::defaultCwd` for the first and the
 * session's real cwd for the second) — cwd has been per-session since the
 * working directory feature, so it can no longer be assumed to equal
 * `home`/`process.cwd()` in here. */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", sanitizeCwd(resolveRealCwd(cwd)), `${sessionId}.jsonl`);
}

/**
 * Rebuilds a session's `history` from the transcript that Claude Code
 * already maintains on its own — used when the relay restarts and loses
 * `SharedSession.history` in memory (it was always in-memory only, never
 * persisted). Translation, not a direct replay — see the rules below for
 * the reasons.
 */
export function readHistoryFromTranscript(home: string, cwd: string, sessionId: string): HistoryEntry[] {
  const path = transcriptPath(home, cwd, sessionId);
  if (!existsSync(path)) return [];

  const messages: HistoryEntry[] = [];
  let turnOpen = false;

  // Runs a raw (synthetic or real) `ClaudeEvent` through the same mapper the
  // live turn uses, pushing zero or more resulting `AgentEvent`s.
  function pushMapped(event: ClaudeEvent): void {
    for (const agentEvent of mapClaudeEvent(event)) messages.push({ type: "agent_event", event: agentEvent });
  }

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    if (!rawLine.trim()) continue;

    let line: TranscriptLine;
    try {
      line = JSON.parse(rawLine) as TranscriptLine;
    } catch {
      // Can only happen on the last line, if something reconnects mid-write
      // — discard instead of breaking the whole replay.
      continue;
    }

    if (line.type === "assistant") {
      // Real timestamp of the line (same as `user_prompt` below) —
      // the client shows it on the assistant bubble's action strip. Omitted
      // when absent, same reasoning as the `user_prompt` case.
      pushMapped({
        type: "assistant",
        message: line.message,
        ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
      });
      continue;
    }

    if (line.type !== "user") continue; // the rest is noise with no visual representation (see module).

    const humanText = extractHumanText(line);
    if (humanText !== undefined) {
      // Closes the previous turn (if one was open) before opening this one
      // — `stopped: false` because a turn that made it into the transcript
      // as a closed, followed-by-another-turn conversation didn't end on a
      // stop. Mirrors `turn_started`/`turn_ended`'s live ordering in
      // `sharedSession.ts::runTurn`.
      if (turnOpen) messages.push({ type: "agent_event", event: { type: "turn_ended", stopped: false } });
      messages.push({ type: "agent_event", event: { type: "turn_started" } });
      // Real timestamp of the line — the client uses this to show
      // "X min ago" on messages reconstructed from disk; whoever sends it
      // live already knows the click's own time, doesn't depend on this.
      // Omitted (not explicit `undefined`) when the line has no
      // `timestamp` — keeps the event's shape identical to before this
      // feature existed in that case.
      pushMapped({
        type: "user_prompt",
        message: { content: [{ type: "text", text: humanText }] },
        ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
      });
      turnOpen = true;
      continue;
    }

    if (isToolResultOnly(line.message?.content)) {
      pushMapped({ type: "user", message: line.message });
    }
    // `isMeta` or unexpected format: ignore, no visual representation.
  }

  // A turn left open at the end of the file is not closed on purpose — it
  // may genuinely be in progress (relay crashed mid-turn). Leaving it open
  // is harmless: `turnInFlight` on the client is local only, unaffected by
  // replay.
  return messages;
}
