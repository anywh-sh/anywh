// Relay protocol types. The wire's event vocabulary itself
// (AgentEvent/ToolKind/StructuredPatchHunk) lives in agent-event.ts, mirrored
// verbatim from the relay — this file is everything else: the other message
// types, and the wrappers that carry an AgentEvent around.
import type { AgentEvent } from "@/lib/relay/agent-event";
export type { AgentEvent, PlanTodo, StructuredPatchHunk, ToolInput, ToolKind } from "@/lib/relay/agent-event";

/** Mirrors the relay's `PermissionMode` (relay/src/session/sessionStore.ts)
 * — no cross-package import here, both sides only agree by convention.
 * Opaque string, not a fixed union: the real vocabulary is whatever the
 * session's own agent def declares (Claude's four, Codex's three), which
 * arrives per-session as `PermissionModeOption[]` below, not a static list. */
export type PermissionMode = string;

/** Mirrors the relay's `PermissionModeOption` (relay/src/session/permissionModes.ts).
 * `pausesForApproval` is the one behavioral bit a UI branches on (e.g. the
 * "this mode never asks" accent) — everything else about a mode (label,
 * hint) is resolved client-side from the id, not shipped over the wire (see
 * `PermissionModeButton`'s `useModeCopy`). */
export interface PermissionModeOption {
  id: PermissionMode;
  pausesForApproval: boolean;
}

/** Mirrors the relay's `ModelChoice` (relay/src/session/sessionStore.ts) —
 * same convention as `PermissionMode` above, no cross-package import. Opaque
 * string, not a fixed union: the real catalog comes from the CLI's own
 * `/model` probe (see `default_model_state` below), not a hardcoded list. */
export type ModelChoice = string;

/** Mirrors the relay's `ContextUsage` (relay/src/session/sessionStore.ts) —
 * `contextWindowSize` itself comes directly from the CLI
 * (`modelUsage[model].contextWindow` from the `result` event), never a
 * static table on the client. */
export interface ContextUsage {
  model: string;
  contextWindowSize: number;
  usedTokens: number;
  baselineTokens?: number;
  /** Mirrors the relay's `ContextBreakdown` (relay/src/context/breakdown.ts)
   * — absent until a `request_context_breakdown` round-trip fills it in.
   * Every field is independently optional: a def may declare no `skills`/
   * `subagents` accounting at all (a real "this category doesn't exist"),
   * and `emptyDirectory` only ever appears for a cwd that's actually empty. */
  breakdown?: {
    rules?: { tokens: number; estimated: true };
    skills?: { tokens: number; estimated: true; count: number };
    subagents?: { tokens: number; estimated: true; count: number };
    emptyDirectory?: { tokens: number; estimated: true };
    residual?: { tokens: number; estimated: false };
  };
}

/** A `history` entry from the relay (relay/src/session/broadcast.ts::BroadcastMessage)
 * — the shape that also shows up batched inside `history_page`/`older_history`
 * instead of one `socket.send` per event. A single variant: turn lifecycle
 * (`turn_started`/`turn_ended`/`error`) is part of `AgentEvent` itself, not a
 * sibling wire message — see agent-event.ts's own doc comment. */
export type HistoryMessage = { type: "agent_event"; event: AgentEvent };

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
export type EditMessageErrorCode = "not_found" | "truncate_failed" | "relay_restarting" | "unsupported";

export type RelayMessage =
  /** First message sent on every connection, ahead of anything else —
   * see protocolVersion.ts and relayClient.ts's handling of it. */
  | { type: "protocol_version"; version: number }
  /** One `AgentEvent` of the session's log — turn lifecycle included (see
   * `AgentEvent`'s own doc comment on `turn_started`/`turn_ended`/`error`). */
  | { type: "agent_event"; event: AgentEvent }
  | { type: "caught_up" }
  /** Recent tail of this session's history — sent once
   * per connection, right before `caught_up`, in place of what used to be
   * one `agent_event` per `socket.send`. */
  | ({ type: "history_page" } & HistoryPageMessage)
  /** Response to a `load_older_history` requested by the client itself
   * (scrolling up) — same shape as `history_page`, just outside the initial
   * connection flow, and only for the socket that asked. */
  | ({ type: "older_history" } & HistoryPageMessage)
  | { type: "cwd_state"; cwd: string; locked: boolean }
  /** Which agent def is driving this session — "current state" pattern like
   * `cwd_state`/`permission_mode_state`, sent again on every new connection
   * and on `SharedSession.switchAgent`. Sent right before
   * `permission_mode_state`/`model_state` in the burst, since both only make
   * sense once the client knows which agent they belong to. */
  | { type: "agent_state"; agentId: string }
  | { type: "set_cwd_error"; code: SetCwdErrorCode }
  | { type: "session_title"; title: string }
  | { type: "session_deleted" }
  /** `available` is optional in the wire type itself, not because the relay
   * ever omits it (`sendPermissionMode` always sends it), but because a
   * client one build behind a relay that added this field should still
   * parse the message rather than choke on an unknown property —
   * `WS_PROTOCOL_VERSION` only needs a bump for a change an older client
   * would MISinterpret, not one it simply doesn't know about yet. */
  | { type: "permission_mode_state"; mode: PermissionMode; available?: PermissionModeOption[] }
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
    /** Why the engine is asking, when it has a channel to report one.
     * Absent, not an empty string, for "no reason given". */
    reason?: string;
  };
  /** The answer should be masked in the UI — an engine-reported signal, not
   * guessed from the question text. Absent on every question that isn't one. */
  secret?: boolean;
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

/** Response of `POST /control/profiles/validate` — the chosen runtime's own
 * answer about the `$HOME` being validated, normalized by that runtime's
 * def (the relay asks whichever CLI the body named, so neither field is
 * Claude-shaped any more), plus `collidesWith` when the relay already has a
 * profile pointed at the same `$HOME`. */
export interface ProfileValidation {
  loggedIn: boolean;
  /** Who is logged in — an email for Claude, absent for a CLI that only
   * reports *how* the session authenticates. */
  account?: string;
  /** What that login is worth, as the CLI worded it ("pro", "ChatGPT") —
   * displayed beside the account, never branched on. */
  plan?: string;
  collidesWith?: string;
}

/** What a relay reports it could carry for one runtime — the summary form
 * (`GET /control/portability`), with paths and sizes but no contents, so
 * "is there anything to copy" is answerable without moving the files to
 * find out. */
export interface PortabilitySnapshot {
  runtimeId: string;
  found: boolean;
  files: { path: string; bytes: number }[];
  /** MCP servers the setup declares. They travel as declarations; signing
   * in to them happens on the destination, by the user. */
  mcpServers: string[];
  warnings: PortabilityWarning[];
}

/** Why a file that copies cleanly may still not work where it lands — a
 * code and its operands, never a sentence, so the wording stays in the
 * dictionary with every other piece of UI text. */
export interface PortabilityWarning {
  kind: "absolute-path" | "file-too-large" | "bundle-truncated";
  path: string;
  detail: string;
}

/** The same read with contents included (`full=1`), which is also exactly
 * what `POST /control/portability/apply` takes. */
export interface PortabilityBundle extends Omit<PortabilitySnapshot, "files"> {
  files: { path: string; contents: string; bytes: number; executable: boolean }[];
  declaration?: { path: string; format: "json" | "toml"; values: Record<string, unknown> };
}

export interface PortabilityApplyResult {
  written: string[];
  /** Paths the destination refused because they would have escaped its
   * config home. Always empty in practice; surfaced rather than swallowed
   * because a silent partial write is the one outcome nobody could
   * diagnose. */
  rejected: string[];
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
