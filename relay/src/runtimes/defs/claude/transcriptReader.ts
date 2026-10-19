import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isToolResultOnly, type ClaudeEvent } from "./session.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";
import type { ToolCallMemo } from "../../streams/claudeToolMapping.js";
import type { AgentEvent } from "../../../protocol/agent-event.js";
import { isNoReply, markSilent, promptOffersSilence } from "../../../protocol/silentEvents.js";

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
  const memos = new Map<string, ToolCallMemo>();
  let turnOpen = false;
  // Epoch ms of the open turn's prompt and of the last line seen since — the
  // transcript is the only clock a replay has.
  let turnStartMs: number | undefined;
  let lastLineMs: number | undefined;
  // The previous line's time, used as the start of a reasoning block: the
  // transcript writes a block only once it is complete, so the moment the
  // model began it is the moment the line before it landed. An
  // approximation (the gap also covers time spent before the block began),
  // good enough for "thought for Ns".
  let previousLineMs: number | undefined;

  // The open turn, as far as recognising a silenced background-job report
  // needs it: where it starts in `messages`, whether it is one of those
  // reports and offered `NO_REPLY`, what the assistant said and whether it
  // used a tool.
  let turnStartIdx = 0;
  let turnUserEvent: Extract<AgentEvent, { type: "user_message" }> | undefined;
  let turnOffered = false;
  let turnAssistantTexts: string[] = [];
  let turnUsedTool = false;
  // Live, a Stop (`stopped: true`) is never silenced. The transcript has no
  // stop record of its own, only the "[Request interrupted by user]" user
  // line Claude Code appends right after an interrupted turn, so that line
  // is the one signal available here. It is not complete: a Stop that left
  // no such line (or a turn still running when the relay died) can't be told
  // from a finished turn, which is why the LAST turn of a file is never
  // collapsed (see the end of this function).
  let turnInterrupted = false;

  /** A report turn the model answered with `NO_REPLY` alone collapses to the
   * minimal marked pair the live relay keeps in `history` (see
   * `protocol/silentEvents.ts`): one `user_message` + `turn_ended`, so the turn
   * count still matches the transcript's `user` lines. Returns whether it did. */
  function collapseIfSilent(): boolean {
    if (!turnUserEvent || !turnOffered || turnUsedTool || turnInterrupted || !isNoReply(turnAssistantTexts.join("\n"))) return false;
    messages.length = turnStartIdx;
    messages.push({ type: "agent_event", event: markSilent(turnUserEvent) });
    messages.push({ type: "agent_event", event: markSilent({ type: "turn_ended", stopped: false }) });
    return true;
  }

  function closeTurn(): void {
    if (collapseIfSilent()) return;
    const durationMs = turnStartMs !== undefined && lastLineMs !== undefined ? Math.max(0, lastLineMs - turnStartMs) : undefined;
    messages.push({ type: "agent_event", event: { type: "turn_ended", stopped: false, ...(durationMs !== undefined ? { durationMs } : {}) } });
  }

  // Runs a raw (synthetic or real) `ClaudeEvent` through the same mapper the
  // live turn uses, pushing zero or more resulting `AgentEvent`s. `lineMs` is
  // the transcript line's own time, applied to what the mapper left untimed.
  function pushMapped(event: ClaudeEvent, lineMs?: number, previousMs?: number): void {
    for (const agentEvent of mapClaudeEvent(event, memos)) {
      messages.push({ type: "agent_event", event: lineMs === undefined ? agentEvent : withReplayTiming(agentEvent, lineMs, previousMs) });
    }
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

    const lineMs = typeof line.timestamp === "string" && !Number.isNaN(Date.parse(line.timestamp)) ? Date.parse(line.timestamp) : undefined;
    const previousMs = previousLineMs;
    if ((line.type === "assistant" || line.type === "user") && lineMs !== undefined) {
      previousLineMs = lineMs;
    }

    if (line.type === "assistant") {
      if (turnOpen && lineMs !== undefined) lastLineMs = lineMs;
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const kind = (block as { type?: unknown }).type;
          if (kind === "tool_use") turnUsedTool = true;
          else if (isTextBlock(block)) turnAssistantTexts.push(block.text);
        }
      }
      // Real timestamp of the line (same as `user_prompt` below) —
      // the client shows it on the assistant bubble's action strip. Omitted
      // when absent, same reasoning as the `user_prompt` case.
      pushMapped({
        type: "assistant",
        message: line.message,
        ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
      }, lineMs, previousMs);
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
      if (humanText.startsWith(INTERRUPT_MARKER)) turnInterrupted = true;
      if (turnOpen) closeTurn();
      turnStartMs = lineMs;
      lastLineMs = lineMs;
      turnStartIdx = messages.length;
      turnUserEvent = undefined;
      turnOffered = false;
      turnAssistantTexts = [];
      turnUsedTool = false;
      turnInterrupted = false;
      messages.push({ type: "agent_event", event: { type: "turn_started", ...(lineMs !== undefined ? { startedAt: lineMs } : {}) } });
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
      const synthetic = backgroundJobPrompt(humanText);
      const pushed = messages.at(-1)?.event;
      if (synthetic && pushed?.type === "user_message") {
        // A job report is not something the user typed: mark it the way the
        // live relay does so the client renders a note, not a user bubble.
        const event: AgentEvent = { ...pushed, synthetic: "background_job", ...(synthetic.label !== undefined ? { label: synthetic.label } : {}) };
        messages[messages.length - 1] = { type: "agent_event", event };
        turnUserEvent = event;
        turnOffered = promptOffersSilence(humanText);
      }
      turnOpen = true;
      continue;
    }

    if (isToolResultOnly(line.message?.content)) {
      if (turnOpen && lineMs !== undefined) lastLineMs = lineMs;
      pushMapped(
        {
          type: "user",
          message: line.message,
          // Same field the live stream carries: what lets a replayed result
          // produce the same outcome (a diff, numbered code) as a live one.
          ...(line.toolUseResult !== undefined ? { tool_use_result: line.toolUseResult } : {}),
        },
        lineMs,
        previousMs,
      );
    }
    // `isMeta` or unexpected format: ignore, no visual representation.
  }

  // The last turn is deliberately NOT collapsed even if it looks like an
  // offered report answered `NO_REPLY`: nothing closes it, so it may be
  // still running, interrupted, or cut by a crash, and the transcript can't
  // say which. Showing a harmless `NO_REPLY` note until the next turn is
  // better than hiding something that was not actually silenced live.

  // A turn left open at the end of the file is not closed on purpose — it
  // may genuinely be in progress (relay crashed mid-turn). Leaving it open
  // is harmless: `turnInFlight` on the client is local only, unaffected by
  // replay.
  return messages;
}

/** Fills the timing a live turn would have got from the session's clock, from
 * the transcript line's own time instead. */
function withReplayTiming(event: AgentEvent, lineMs: number, previousMs: number | undefined): AgentEvent {
  if (event.type === "tool_started") return { ...event, startedAt: lineMs };
  if (event.type === "tool_ended") return { ...event, endedAt: lineMs };
  if (event.type === "thinking") return { ...event, startedAt: previousMs ?? lineMs, endedAt: lineMs };
  return event;
}

/** A background-job report prompt (`[anywh-bg]` line, see
 * `session/turnMessages.ts`) and its job label, or `undefined` for anything
 * a person typed. */
function backgroundJobPrompt(text: string): { label: string | undefined } | undefined {
  if (!text.startsWith("[anywh-bg]")) return undefined;
  const label = /^\[anywh-bg\][^\n]*?"([^\n]*)" que você iniciou/.exec(text)?.[1];
  return { label };
}

/** Text Claude Code writes as a user line when the user interrupts a turn. */
const INTERRUPT_MARKER = "[Request interrupted by user";
