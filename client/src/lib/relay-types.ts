// Relay protocol types, extended from what already existed in
// relayClient.ts, informed by inspecting real stream-json events from a
// live relay.

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  input?: {
    command?: string;
    description?: string;
    file_path?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    [key: string]: unknown;
  };
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface ClaudeMessage {
  role?: string;
  content?: ClaudeContentBlock[];
}

/** A `structuredPatch` line that the relay already receives ready-made from
 * Edit — we don't need to compute the diff on the client. */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ToolUseResult {
  filePath?: string;
  oldString?: string;
  newString?: string;
  structuredPatch?: StructuredPatchHunk[];
  [key: string]: unknown;
}

// Streaming envelope from the (Anthropic) Messages API, as it arrives inside
// `claude_event.event` when `claude_event.type === "stream_event"`.
export type StreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };

export type StreamEventEnvelope =
  | { type: "message_start" }
  | { type: "content_block_start"; index: number; content_block: ClaudeContentBlock }
  | { type: "content_block_delta"; index: number; delta: StreamDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" }
  | { type: "message_stop" };

/** Present on `type: "system", subtype: "compact_boundary"` — fired when
 * Claude Code compacts the conversation (automatically when nearing the
 * window limit, or via manual `/compact`). The relay doesn't treat this
 * event specially: it already passes through the generic `onEvent` like any
 * other (`runtimes/defs/claude/session.ts` doesn't filter by type), it just needed a type
 * here so the client can recognize it without needing `as`. */
export interface CompactBoundaryMetadata {
  trigger: "auto" | "manual";
  preTokens: number;
}

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  message?: ClaudeMessage;
  session_id?: string;
  result?: string;
  status?: string;
  /** Present only when type === "stream_event". */
  event?: StreamEventEnvelope;
  /** Present on "user" events that are a tool_result — see ToolUseResult. */
  tool_use_result?: ToolUseResult;
  /** Present on `type: "system", subtype: "compact_boundary"`. */
  compactMetadata?: CompactBoundaryMetadata;
  /** On `type: "assistant"` this is a genuine field the CLI itself stamps on
   * every stream-json line — present both live and on replay
   * (relay/src/transcriptReader.ts). On `type: "user_prompt"` (synthetic)
   * it's ISO from the real `.jsonl` line on replay, or absent in the live
   * broadcast to other devices — whoever sent the message already
   * knows their own click time, doesn't depend on this. Either way,
   * `useMessageLog.ts` falls back to `Date.now()` when absent. */
  timestamp?: string;
  [key: string]: unknown;
}

/** Mirrors the relay's `PermissionMode` (relay/src/sessionStore.ts) — no
 * cross-package import here, both sides only agree by convention. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Mirrors the relay's `ModelChoice` (relay/src/sessionStore.ts) — same
 * convention as `PermissionMode` above, no cross-package import. Opaque
 * string, not a fixed union: the real catalog comes from the CLI's own
 * `/model` probe (see `default_model_state` below), not a hardcoded list. */
export type ModelChoice = string;

/** Mirrors the relay's `ContextUsage` (relay/src/sessionStore.ts) —
 * `contextWindowSize` itself comes directly from the CLI
 * (`modelUsage[model].contextWindow` from the `result` event), never a
 * static table on the client. */
export interface ContextUsage {
  model: string;
  contextWindowSize: number;
  usedTokens: number;
}

/** A `history` entry from the relay (relay/src/sharedSession.ts::BroadcastMessage)
 * — the subset of `RelayMessage` that also shows up inside
 * `history_page`/`older_history`, batched instead of one `socket.send` per
 * event. */
export type HistoryMessage =
  | { type: "claude_event"; event: ClaudeEvent }
  | { type: "turn_complete"; stopped?: boolean }
  | { type: "turn_error"; message: string };

/** History page — shape shared by `history_page` (initial tail) and
 * `older_history` (response to `load_older_history`). `hasMore` indicates
 * whether there are older turns than `cursor` left to fetch. */
export interface HistoryPageMessage {
  messages: HistoryMessage[];
  cursor: number;
  hasMore: boolean;
}

/**
 * Why changing the session folder failed. Mirrors `SetCwdError` in
 * relay/src/sharedSession.ts — the relay sends a code, never a sentence, and
 * the wording (and its language) is the client's to own. Adding a code here
 * without adding its string to the dictionary is a compile error, which is
 * the point: `errors.setCwd` is typed as a record over this union.
 */
export type SetCwdErrorCode = "not_found" | "permission_denied" | "not_a_directory" | "invalid_path" | "locked";

/** Why an `edit_message` request was refused. Mirrors `EditMessageError` in
 * relay/src/sharedSession.ts, same contract as `SetCwdErrorCode`. */
export type EditMessageErrorCode = "not_found" | "truncate_failed" | "relay_restarting";

export type RelayMessage =
  | { type: "claude_event"; event: ClaudeEvent }
  | { type: "turn_complete"; stopped?: boolean }
  | { type: "turn_error"; message: string }
  | { type: "caught_up" }
  /** Recent tail of this session's history — sent once
   * per connection, right before `caught_up`, in place of what used to be
   * one `claude_event`/`turn_complete` per `socket.send`. */
  | ({ type: "history_page" } & HistoryPageMessage)
  /** Response to a `load_older_history` requested by the client itself
   * (scrolling up) — same shape as `history_page`, just outside the initial
   * connection flow, and only for the socket that asked. */
  | ({ type: "older_history" } & HistoryPageMessage)
  | { type: "cwd_state"; cwd: string; locked: boolean }
  | { type: "set_cwd_error"; code: SetCwdErrorCode }
  | { type: "session_title"; title: string }
  | { type: "session_deleted" }
  | { type: "permission_mode_state"; mode: PermissionMode }
  | { type: "model_state"; model: ModelChoice | null }
  | { type: "context_usage_state"; usage: ContextUsage | null }
  /** Composer text not yet sent — "current" state (same reasoning as
   * `cwd_state`/`permission_mode_state`), sent again on every new connection
   * so the draft survives an app crash/restart. */
  | { type: "draft_state"; draft: string }
  /** Turn in progress in the session — "current" state (same reasoning as
   * `cwd_state`/`permission_mode_state`), sent again on every new connection.
   * `startedAt` (epoch ms) lets `TurnIndicator`'s timer count from
   * the turn's real start even on a device that wasn't the one that sent the
   * message, or that connected mid-turn — without this only the sender saw
   * the indicator (a real finding from testing multi-device). `undefined`
   * when `active` is `false`. */
  | { type: "turn_state"; active: boolean; startedAt?: number }
  /** `/clear` — per-connection signal (doesn't enter replay),
   * notifies an already-connected client that the conversation was reset;
   * whoever connects afterward naturally sees the empty history already. */
  | { type: "conversation_reset" }
  /** This profile's actual default account model, probed once at
   * relay boot — not per session, it's the same value for every connection
   * of this process. Used as a display fallback when the session never ran
   * `/model` (`model_state` still `null`). `available` is the full model
   * catalog straight from the CLI's own usage text (defaultModel.ts) —
   * source of truth for every model picker in the UI, replacing what used to
   * be a hardcoded list. */
  | { type: "default_model_state"; label: string; available: string[] }
  /** Next-message suggestion, generated asynchronously at the end of every
   * successful turn (relay/src/sharedSession.ts) — shown as the composer's
   * placeholder when the field is empty. `null` both for "no suggestion yet"
   * and for "the previous suggestion is no longer valid" (new turn
   * starting, `/clear`). */
  | { type: "suggestion"; text: string | null }
  /** `anywh-bg` jobs currently observed in the session — "current" state
   * (same reasoning as `cwd_state`/`turn_state`), sent again on every new
   * connection and whenever the list changes (a job starting, ending or
   * expiring — see relay/src/sessionManager.ts::syncBackgroundJobState).
   * Empty array (not omitted) when there are none. */
  | { type: "background_job_state"; jobs: BackgroundJobSummary[] }
  /** Message editing — sent only to the OTHER devices connected to
   * the session (whoever edited already self-truncated optimistically, like
   * a normal send); syncs the cut-off point before the new turn starts
   * transmitting. Same shape as `history_page`, handled the same way on the
   * client (reset + hydrate). */
  | ({ type: "history_truncated" } & HistoryPageMessage)
  /** Response to an invalid `edit_message` (message not found — e.g. history
   * changed by another device) or one that failed to truncate the real
   * transcript. Only for the socket that requested it. */
  | { type: "edit_message_error"; code: EditMessageErrorCode }
  /** The model called `present_choice` mid-turn and is genuinely
   * blocked waiting for an answer. "Current state" pattern like
   * `cwd_state`/`turn_state`: sent again to a device that (re)connects
   * mid-wait, not just to whoever was already there. Answer with
   * `choice_answer` (`{ type: "choice_answer", promptId, answers }`).
   * `kind` distinguishes the two `SharedSession` slots that both feed this
   * same message (`pendingApproval`/`pendingChoice`, sharedSession.ts) —
   * `"approval"` is a live blocked tool call that genuinely needs SOME
   * answer to unblock it, `"choice"` is a deferred `present_choice`/
   * plan-marker prompt that tolerates being closed with no answer at all
   * (`ChoiceCard`'s close button behaves differently per kind). */
  | { type: "choice_prompt"; promptId: string; questions: ChoiceQuestion[]; kind: "approval" | "choice" }
  /** The prompt above was answered (by any device) or the turn that asked
   * it ended before anyone answered — dismiss it everywhere it's shown. */
  | { type: "choice_resolved"; promptId: string };

/** Mirrors the relay's `ChoiceOption`/`ChoiceQuestion`/`ChoiceAnswer`
 * (relay/src/mcpBridge.ts) — same no-cross-package-import
 * convention as `PermissionMode`/`ModelChoice` above. Schema mirrors the
 * native `AskUserQuestion` tool's real input on purpose — the model has
 * training affinity with this exact shape. */
export interface ChoiceOption {
  label: string;
  description?: string;
  /** Set only on an option the relay wrote (a permission prompt). The answer
   * carries this instead of the label whenever it's present, so what the user
   * reads and what the relay matches on are no longer the same string. */
  id?: string;
}

export interface ChoiceQuestion {
  question: string;
  header?: string;
  options: ChoiceOption[];
  multiSelect?: boolean;
  /** Present only on a permission prompt. The relay sends the parts rather
   * than only the finished English sentence in `question`, so the card can
   * ask in the language the user picked. */
  approval?: {
    tool: string;
    detail: string;
  };
}

export interface ChoiceAnswer {
  question: string;
  selected: string[];
}

/** An `anywh-bg` job currently observed in this session.
 * Mirrors the relay's `BackgroundJobSummary` (relay/src/backgroundJobs.ts):
 * no file path or `sessionId` (the session is already the WS connection's). */
export interface BackgroundJobSummary {
  id: string;
  label: string;
  startedAt: number;
}

/** A session as the relay exposes it on `GET /sessions` — `id` is stable
 * since creation, `title` is what the sidebar shows (inferred from the first
 * prompt or set by manual rename). */
export interface SessionSummary {
  id: string;
  title: string;
  /** Epoch ms of the last turn, the field the relay already sorted this list
   * by. On the wire because the sidebar buckets sessions by recency, and a
   * list merged across profiles loses the relay's own ordering — each side's
   * rows have to be re-sorted against each other, which needs the key.
   *
   * `null` when the relay didn't send one. A self-hosted install updates the
   * client and the relay separately, so a relay older than the release that
   * added this field is a normal state, not a broken one: `fetchSessions`
   * normalizes it here so the rest of the app has one shape to handle
   * instead of an `undefined` that types claim can't happen. */
  lastActiveAt: number | null;
}

/** A profile as the relay's control API exposes it on `GET /control/profiles`
 * — one entry per `.env` file it finds on that host, live-probed for
 * `running` (see `relay/src/profileRegistry.ts::HostProfile`). `host`/`port`
 * here, unlike `Profile.relayPort` on the client's own store, mirror the
 * relay's own field names. */
export interface RemoteProfile {
  id: string;
  label: string;
  colorIndex: number;
  host: string;
  port: number;
  hasHomeOverride: boolean;
  running: boolean;
  /** Custom theme this profile uses, absent for the built-in one. Comes
   * from the host registry rather than local settings so the choice follows
   * the profile to every device (relay/src/profileRegistry.ts). */
  themeId?: string;
}

/** Response of `POST /control/profiles/validate` — passes through whatever
 * `claude auth status --json` reports (a real account has more fields than
 * these, e.g. `authMethod`/`orgName`, safely ignored), plus `collidesWith`
 * when the relay already has a profile pointed at the same `$HOME`. */
export interface ProfileValidation {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  collidesWith?: string;
}

/** Response of `POST /control/profiles` — enough to build the local
 * `Profile` (`addProfile`) once the relay finishes provisioning. */
export interface CreatedProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  colorIndex: number;
}

/** Response of `PATCH /control/profiles/:id` — the merged `profiles.json`
 * entry. No `host`/`port` here (those live in the `.env`, untouched by a
 * rename) — merge onto the existing local `Profile` instead of replacing it. */
export interface ProfileMetaUpdate {
  id: string;
  label: string;
  colorIndex: number;
  createdAt: string;
  updatedAt: string;
}
