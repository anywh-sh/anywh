/**
 * The relay's own vocabulary for what an agent CLI is doing during a turn —
 * this, not any CLI's raw stream format, is what crosses the wire (as
 * `{type: "agent_event", event}`) and what gets persisted in a session's
 * `history`. A def (`runtimes/defs/<agent>/`) maps whatever its CLI actually
 * emits into this shape; nothing downstream of the mapper — the wire, the
 * client, a future second def — needs to know the source CLI's format.
 *
 * Two variants are synthesized by the session layer itself, not mapped from
 * any CLI output: `turn_started` (right before a turn's first effect) and
 * `turn_ended` (once it's done, however it ended). They replace what used to
 * be separate `turn_complete`/`turn_error` wire messages — folding turn
 * lifecycle into the same stream a persisted log already has to record turn
 * boundaries in anyway, instead of keeping two parallel vocabularies for
 * "what happened" and "when did the turn end".
 *
 * Mirrored verbatim at relay/src/protocol/agent-event.ts — there is no
 * shared package between the two npm projects (see docs/architecture.md) —
 * and agentEventParity.test.ts keeps the two copies from drifting apart in
 * silence, same mechanism as theme.ts/protocolVersion.ts. That test compares
 * everything from the first `export` on, so this header is the only part
 * allowed to differ between the two copies (each names the other).
 *
 * `ToolKind` below is what a tool call actually does, independent of which
 * CLI or tool name produced it — this is what a UI groups/icons by, not the
 * raw tool name. `"other"` is not a failure case: a def maps a tool it
 * doesn't recognize (a new one the CLI shipped, an MCP tool with no special
 * meaning) to `"other"` and logs the unrecognized name once, rather than
 * throwing — the generic fallback rendering already handles it.
 */
export type ToolKind = "shell" | "edit" | "write" | "read" | "search" | "task" | "mcp" | "web" | "other";

/** A `structuredPatch` hunk the CLI already computed for an edit — kept
 * ready-made so nothing downstream needs to diff file contents itself. */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A tool call's arguments, generic across tools — only the fields a
 * renderer actually special-cases are named; everything else still arrives
 * (the index signature), for the generic key/value fallback. */
export interface ToolInput {
  command?: string;
  description?: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  content?: string;
  [key: string]: unknown;
}

/** One item of a `TodoWrite`-shaped plan. `activeForm` is optional because
 * it only makes sense for the item currently `"in_progress"`. */
export interface PlanTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type AgentEvent =
  /** Synthesized by the session, not mapped from CLI output — see the file
   * doc comment. Fires once, before anything else for this turn. */
  | { type: "turn_started" }
  /** Synthesized by the session — replaces `turn_complete`. `stopped` is
   * `true` only when the turn ended because the user asked to stop it, never
   * because the CLI genuinely finished or errored. */
  | { type: "turn_ended"; stopped: boolean }
  /** A human message — sent live by whoever's device submitted it (so OTHER
   * devices see the question that prompted the response), or reconstructed
   * from an on-disk transcript. `synthetic: "background_job"` marks an
   * `anywh-bg` job's automatic follow-up; `synthetic: "wakeup"` marks a
   * `ScheduleWakeup` timer firing on its own — neither is ever a real human
   * message, both shown as a system note rather than a chat bubble.
   * `timestamp` is the real on-disk time on replay, absent live (whoever
   * sent it already knows the click's own time). */
  | { type: "user_message"; text: string; timestamp?: string; synthetic?: "background_job" | "wakeup"; label?: string }
  /** Live streaming preview of a growing text block — `index` correlates
   * multiple chunks (and, in principle, multiple concurrently-streaming
   * blocks) to the same block before it commits as `text`. */
  | { type: "text_delta"; index: number; text: string }
  /** The committed, final form of a text block. */
  | { type: "text"; text: string; timestamp?: string }
  /** Same relationship to `thinking` as `text_delta` has to `text`. */
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "thinking"; thinking: string; timestamp?: string }
  /** A tool call beginning — `toolUseId` pairs it with the `tool_ended` that
   * eventually closes it (or never arrives, if the turn was interrupted
   * first). `kind` is the def's own classification (see `ToolKind`); `name`
   * is the CLI's raw tool name, kept for display and for a future def's own
   * bridges to key off of. */
  | { type: "tool_started"; toolUseId?: string; name: string; kind: ToolKind; input: ToolInput }
  /** Live streaming preview of a tool call's arguments as they're being
   * generated — no current def emits this yet (nothing renders it either),
   * here for the def that will. */
  | { type: "tool_input_delta"; toolUseId?: string; partialJson: string }
  /** A long-running tool call reporting interim state before it's done —
   * no current def emits this yet, same reasoning as `tool_input_delta`. */
  | { type: "tool_progress"; toolUseId?: string; text: string }
  /** A tool call's result — `content` is already flattened to a plain
   * string (never the raw content-block array a CLI might use internally),
   * so nothing downstream needs to know that shape existed. */
  | { type: "tool_ended"; toolUseId?: string; content: string; isError: boolean; structuredPatch?: StructuredPatchHunk[] }
  /** A plan/todo-list update (`TodoWrite` on Claude) — carries structured
   * `todos` instead of opaque `input` because, unlike an arbitrary tool call,
   * the shape is part of the contract, not private to one CLI. `toolUseId`
   * still pairs this with its own `tool_ended` (the tool's ack), so a def
   * doesn't need a second lifecycle just for plans. */
  | { type: "plan"; toolUseId?: string; todos: PlanTodo[] }
  /** The CLI's own identifier for this conversation, whenever the def learns
   * it (may fire more than once in a turn; the value never changes within a
   * turn) — the seam a future rewind/persisted-log feature needs, unused by
   * anything today. */
  | { type: "session_id"; sessionId: string }
  /** Token usage of a single model response (never a turn-wide aggregate —
   * see `runtimes/defs/claude/session.ts`'s own doc comment on why an
   * aggregate that includes subagents is actively misleading). `inputTokens`/
   * `cacheCreationInputTokens`/`cacheReadInputTokens` are each def's raw,
   * CLI-specific fields — their semantics differ across agents (Codex's
   * `cacheReadInputTokens` is a subset of `inputTokens`, not additive like
   * Claude's), so nothing downstream may sum them across defs.
   * `prefixTokens`/`outputTokens` are what every def normalizes into: the
   * one pair of numbers comparable between agents, and the only fields a
   * cross-agent consumer may read from this event. `outputTokens` is
   * trustworthy for Codex (a structured daemon notification) but NOT for
   * Claude today — `claudeStreamJson.ts`'s own comment on `output_tokens`
   * has the measured numbers showing the live stream reports a near-constant
   * placeholder regardless of the real reply length. */
  | {
      type: "usage";
      inputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      prefixTokens: number;
      outputTokens: number;
      contextWindowSize?: number;
    }
  /** A CLI-reported status change with no more specific event of its own yet
   * — today this is only ever a permission-mode change the CLI itself
   * decided (`ExitPlanMode` and friends already sync `permission_mode_state`
   * as a side effect independent of this event; this is the log's own
   * record of the same fact). */
  | { type: "status"; permissionMode?: string }
  /** Claude Code compacted the conversation (automatic, near the context
   * limit, or a manual `/compact`). */
  | { type: "compact_boundary"; trigger: "auto" | "manual"; preTokens: number }
  /** Synthesized by the session — replaces `turn_error`. A turn-ending
   * failure (spawn error, the CLI exiting non-zero, an unrecoverable `result`
   * error) — never a tool-level error, which is `tool_ended.isError`. */
  | { type: "error"; message: string };
