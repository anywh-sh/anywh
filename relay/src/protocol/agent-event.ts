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
 * Mirrored verbatim at client/src/lib/relay/agent-event.ts — there is no shared
 * package between the two npm projects (see docs/architecture.md) — and
 * agentEventParity.test.ts keeps the two copies from drifting apart in
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

/** What a tool call is doing, already interpreted by the def that mapped it
 * — the verb and the target a UI shows come from here, never from the raw
 * tool name. Every def maps into this same shape (Claude's `Read` and a
 * Codex `sed -n 1,80p` that its own `commandActions` flags as a read both
 * become `{ kind: "read", path }`), which is what lets a UI stay
 * agent-agnostic. Optional on the wire: a def that can't interpret a call
 * leaves it out, and the UI falls back to `name`/`input`.
 *
 * `mcp` carries the server name on purpose: the relay's own MCP bridges
 * (the structured-question and approval servers) are recognized by it and
 * hidden from the log — they already have their own UI. */
export type ToolSubject =
  | { kind: "read"; path: string; range?: { start: number; end?: number } }
  | { kind: "edit" | "write"; path: string }
  | { kind: "shell"; command: string }
  | { kind: "search"; mode: "files" | "content"; pattern: string; path?: string }
  | { kind: "web"; mode: "search"; query: string }
  | { kind: "web"; mode: "fetch"; url: string }
  | { kind: "mcp"; server: string; tool: string }
  | { kind: "task" | "other"; label: string };

/** A tool call's result, already in the shape a UI draws it — a def does
 * the parsing once, so no consumer needs to know what a CLI's raw result
 * looked like. `tool_ended.content` stays the plain-text form next to it:
 * it's the fallback rendering and what a "copy" action copies.
 * `startLine` is optional because some reads have no known offset (a shell
 * `cat` of a whole file does, a piped command doesn't) — absent means "don't
 * number the lines", never "start at 1". */
export type ToolOutcome =
  | { kind: "code"; path: string; lines: string[]; startLine?: number; totalLines?: number }
  | { kind: "diff"; path: string; hunks: StructuredPatchHunk[]; added: number; removed: number; created?: boolean }
  | { kind: "terminal"; output: string; exitCode?: number }
  | { kind: "files"; paths: string[]; total?: number }
  | { kind: "matches"; matches: { path: string; line?: number; text: string }[]; total?: number }
  | { kind: "links"; results: { title: string; url: string }[] }
  | { kind: "payload"; request: string; response: string }
  | { kind: "text" };

/** One item of a `TodoWrite`-shaped plan. `activeForm` is optional because
 * it only makes sense for the item currently `"in_progress"`. */
export interface PlanTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type AgentEvent =
  /** Synthesized by the session, not mapped from CLI output — see the file
   * doc comment. Fires once, before anything else for this turn. `startedAt`
   * (epoch ms) is the relay's own clock. */
  | { type: "turn_started"; startedAt?: number }
  /** Synthesized by the session — replaces `turn_complete`. `stopped` is
   * `true` only when the turn ended because the user asked to stop it, never
   * because the CLI genuinely finished or errored. `durationMs` is the whole
   * turn as the relay measured it live, or as the source recorded it on
   * replay. */
  | { type: "turn_ended"; stopped: boolean; durationMs?: number }
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
   * blocks) to the same block before it commits as `text`. A number for a
   * def whose CLI correlates blocks by position (Claude), a string for one
   * that correlates by item id (Codex) — only ever compared for equality. */
  | { type: "text_delta"; index: number | string; text: string }
  /** The committed, final form of a text block. */
  | { type: "text"; text: string; timestamp?: string }
  /** A reasoning block began — lets a UI show it as in progress before any
   * of its text (which is often empty, see `thinking`) arrives. Reasoning
   * blocks never run concurrently, so the next `thinking` closes the most
   * recent one: no id needed. */
  | { type: "thinking_started"; startedAt?: number }
  /** Same relationship to `thinking` as `text_delta` has to `text`. */
  | { type: "thinking_delta"; index: number | string; thinking: string }
  /** A committed reasoning block. `thinking` may be empty: some models
   * report that reasoning happened without exposing its text, and the block
   * still matters for its timing. */
  | { type: "thinking"; thinking: string; timestamp?: string; startedAt?: number; endedAt?: number }
  /** A tool call beginning — `toolUseId` pairs it with the `tool_ended` that
   * eventually closes it (or never arrives, if the turn was interrupted
   * first). `kind` is the def's own classification (see `ToolKind`); `name`
   * is the CLI's raw tool name, kept as the fallback label when `subject` is
   * absent. `batchId` is shared by calls the agent issued together (parallel
   * calls) — absent when the def has no such signal, never guessed.
   *
   * Timestamps (`startedAt` here, `endedAt` on `tool_ended`, and the ones on
   * `thinking`/`turn_*`) are epoch ms. A def fills them in when its CLI
   * reports real ones; whatever it leaves out, the session stamps with its
   * own clock as the event arrives — so a consumer can rely on them being
   * present on anything the relay broadcast live. */
  | {
      type: "tool_started";
      toolUseId?: string;
      name: string;
      kind: ToolKind;
      input: ToolInput;
      subject?: ToolSubject;
      startedAt?: number;
      batchId?: string;
    }
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
  | {
      type: "tool_ended";
      toolUseId?: string;
      content: string;
      isError: boolean;
      structuredPatch?: StructuredPatchHunk[];
      outcome?: ToolOutcome;
      endedAt?: number;
    }
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
  /** Synthesized by `SharedSession` (never emitted by a driver directly),
   * same as `turn_started`/`user_message` — one per tool call `toolUseId`
   * that contributed to a `usage` delta, carrying that tool's own share of
   * the tokens injected between it and the previous response.
   * `toolUseIds` is an array for symmetry with `contextAttribution.ts`'s
   * internal `Attribution` type, but every event synthesized today carries
   * exactly one id: a parallel batch of N tool calls fans out into N of
   * these events, each already divided, rather than one event carrying N
   * ids and a combined total. `estimated: false` for a delta with exactly
   * one tool call (the number is exact); `true` when it was divided
   * proportionally across a parallel batch (the total is still exact, only
   * the SPLIT across the batch is a model — see the doc comment on
   * `contextAttribution.ts`'s `divideProportionally`). */
  | { type: "context_attribution"; toolUseIds: string[]; tokens: number; estimated: boolean }
  /** Synthesized by the session — replaces `turn_error`. A turn-ending
   * failure (spawn error, the CLI exiting non-zero, an unrecoverable `result`
   * error) — never a tool-level error, which is `tool_ended.isError`. */
  | { type: "error"; message: string };
