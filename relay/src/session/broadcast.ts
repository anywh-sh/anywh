import type { WebSocket } from "ws";
import type { AgentEvent } from "../protocol/agent-event.js";
import type { ChoiceQuestion } from "../bridges/mcpBridge.js";
import type { ContextUsage, ModelChoice, PermissionMode } from "./sessionStore.js";
import type { PermissionModeOption } from "./permissionModes.js";
import type { BackgroundJobSummary } from "../host/backgroundJobs.js";

// A single variant — turn lifecycle used to be two separate sibling
// messages (`turn_complete`/`turn_error`) alongside `claude_event`; both
// folded into `AgentEvent` itself (`turn_ended`/`error`), so there's nothing
// left to union here. Kept as a named type (not inlined at every call site)
// since `historyPaging.ts`/`sharedSession.ts` reference it by name.
export type BroadcastMessage = { type: "agent_event"; event: AgentEvent };

// `suggestion` (and other "current" states: cwd_state, permission_mode_state
// etc.) deliberately doesn't enter `BroadcastMessage`/`history` — they're
// sent directly via socket.send instead of `broadcast`, and a reconnection
// picks up the current value via `addClient`, not a replay of past changes.

/** Always sends, even an empty list — same as `sendCwdState`/`sendTurnState`,
 * there's no "hasn't arrived yet" ambiguity here to justify a guard (a
 * session with no jobs and one that never had one look the same to the
 * client: neither shows the indicator). */
export function sendBackgroundJobs(target: WebSocket, jobs: BackgroundJobSummary[]): void {
  target.send(JSON.stringify({ type: "background_job_state", jobs }));
}

export function broadcastBackgroundJobs(clients: Iterable<WebSocket>, jobs: BackgroundJobSummary[]): void {
  for (const client of clients) sendBackgroundJobs(client, jobs);
}

/** Same "current state" pattern as `sendCwdState`/`sendTurnState`:
 * a device that reconnects (or connects for the first time) mid-wait needs
 * to see the pending question immediately, not just devices that were
 * already there when it was asked. */
export function sendChoicePrompt(target: WebSocket, prompt: { promptId: string; questions: ChoiceQuestion[] }, kind: "approval" | "choice"): void {
  target.send(JSON.stringify({ type: "choice_prompt", promptId: prompt.promptId, questions: prompt.questions, kind }));
}

/** Takes the prompt explicitly (rather than a field on some owning object)
 * since both `presentChoice` and `presentApprovalChoice` (choiceMachine.ts)
 * call this right after setting their own respective slot — passing it in
 * keeps this function agnostic to which of the two it's broadcasting for.
 * `kind` is passed alongside for the same reason and tells the client which
 * close behavior applies — see the `choice_prompt` doc comment in
 * relay-types.ts. */
export function broadcastChoicePrompt(clients: Iterable<WebSocket>, prompt: { promptId: string; questions: ChoiceQuestion[] }, kind: "approval" | "choice"): void {
  for (const client of clients) sendChoicePrompt(client, prompt, kind);
}

/** Tells every connected device the prompt is gone — including whichever
 * one(s) didn't answer, so a stale picker doesn't linger once another
 * device already resolved it. */
export function broadcastChoiceResolved(clients: Iterable<WebSocket>, promptId: string): void {
  for (const client of clients) client.send(JSON.stringify({ type: "choice_resolved", promptId }));
}

export function sendTurnState(target: WebSocket, startedAt: number | null): void {
  target.send(JSON.stringify({ type: "turn_state", active: startedAt !== null, startedAt: startedAt ?? undefined }));
}

export function broadcastTurnState(clients: Iterable<WebSocket>, startedAt: number | null): void {
  for (const client of clients) sendTurnState(client, startedAt);
}

export function sendCwdState(target: WebSocket, cwd: string, locked: boolean): void {
  target.send(JSON.stringify({ type: "cwd_state", cwd, locked }));
}

export function broadcastCwdState(clients: Iterable<WebSocket>, cwd: string, locked: boolean): void {
  for (const client of clients) sendCwdState(client, cwd, locked);
}

/** Which agent def is currently driving this session — sent right before
 * `permission_mode_state`/`model_state` in the connection burst (both only
 * make sense once the client knows which agent they belong to) and again on
 * `SharedSession.switchAgent`. */
export function sendAgentState(target: WebSocket, agentId: string): void {
  target.send(JSON.stringify({ type: "agent_state", agentId }));
}

export function broadcastAgentState(clients: Iterable<WebSocket>, agentId: string): void {
  for (const client of clients) sendAgentState(client, agentId);
}

/** `available` is this session's own def's mode vocabulary for the host's
 * platform (`session/permissionModes.ts`'s `availableModes`) — sent
 * alongside `mode` on every burst/change so the client never has to
 * cross-reference a separate, per-relay list (`GET /host-info`) against
 * this session's agent to know what to render; see `SharedSession`'s
 * `sendPermissionMode`/`broadcastPermissionMode` call sites for why. */
export function sendPermissionMode(target: WebSocket, mode: PermissionMode, available: readonly PermissionModeOption[]): void {
  target.send(JSON.stringify({ type: "permission_mode_state", mode, available }));
}

export function broadcastPermissionMode(clients: Iterable<WebSocket>, mode: PermissionMode, available: readonly PermissionModeOption[]): void {
  for (const client of clients) sendPermissionMode(client, mode, available);
}

/** Unlike `sendContextUsage`, always sends — an undefined `model` is a
 * valid, final state ("never chosen, uses the CLI's default"), not a
 * transient "hasn't arrived yet", so there's no ambiguity in notifying
 * the client right at connection. */
export function sendModelState(target: WebSocket, model: ModelChoice | undefined): void {
  target.send(JSON.stringify({ type: "model_state", model: model ?? null }));
}

export function broadcastModelState(clients: Iterable<WebSocket>, model: ModelChoice | undefined): void {
  for (const client of clients) sendModelState(client, model);
}

export function sendDraftState(target: WebSocket, draft: string): void {
  target.send(JSON.stringify({ type: "draft_state", draft }));
}

/** Same reasoning as `broadcastCwdState`/`broadcastPermissionMode`: "current"
 * state, not a `history` event — a reconnection picks up the current
 * value via `addClient` (`sendDraftState`), not a replay of changes. */
export function broadcastDraftState(clients: Iterable<WebSocket>, draft: string): void {
  for (const client of clients) sendDraftState(client, draft);
}

export function sendContextUsage(target: WebSocket, usage: ContextUsage | undefined): void {
  if (!usage) return;
  target.send(JSON.stringify({ type: "context_usage_state", usage }));
}

/** Same reasoning as `broadcastCwdState`/`broadcastTitle`: "current"
 * state, not a `history` event — a reconnection picks up the current
 * value via `addClient` (`sendContextUsage`), not a replay of changes. */
export function broadcastContextUsage(clients: Iterable<WebSocket>, usage: ContextUsage | undefined): void {
  for (const client of clients) sendContextUsage(client, usage);
}

/** Only used when a `/clear` (or equivalent) resets the conversation —
 * unlike `sendContextUsage`, sends even without a value (`null`), because
 * the goal here is to tell whoever is already connected that the
 * previous value no longer applies (`sendContextUsage`'s guard exists to
 * avoid confusing "new session, never had a turn" with "had one and was
 * reset"). */
export function broadcastContextUsageReset(clients: Iterable<WebSocket>): void {
  for (const client of clients) {
    client.send(JSON.stringify({ type: "context_usage_state", usage: null }));
  }
}

/** Only for already-connected clients (same reasoning as
 * `broadcastContextUsageReset`) — whoever connects after the clear
 * already sees the empty `history` naturally via `addClient`, no signal
 * needed. */
export function broadcastConversationReset(clients: Iterable<WebSocket>): void {
  for (const client of clients) {
    client.send(JSON.stringify({ type: "conversation_reset" }));
  }
}

/** Unlike `sendContextUsage`, always sends (even `null`) — there's no
 * "hasn't arrived yet" ambiguity to tell apart here: a session with no
 * suggestion yet and one whose suggestion was cleared look the same to
 * the client (neither shows any placeholder), so it doesn't need the
 * guard `sendContextUsage` has. */
export function sendSuggestion(target: WebSocket, text: string | null): void {
  target.send(JSON.stringify({ type: "suggestion", text }));
}

export function broadcastSuggestion(clients: Iterable<WebSocket>, text: string | null): void {
  for (const client of clients) sendSuggestion(client, text);
}

export function sendTitle(target: WebSocket, title: string): void {
  target.send(JSON.stringify({ type: "session_title", title }));
}

/** Doesn't enter `history` for the same reason as cwd: it's "current"
 * state, not a conversation event — a client reconnecting picks up the
 * current value via `addClient`, not a replay of past changes. */
export function broadcastTitle(clients: Iterable<WebSocket>, title: string | null): void {
  if (title === null) return;
  for (const client of clients) sendTitle(client, title);
}

export function broadcast(clients: Iterable<WebSocket>, history: BroadcastMessage[], message: BroadcastMessage): void {
  history.push(message);
  const payload = JSON.stringify(message);
  for (const client of clients) {
    client.send(payload);
  }
}

/** Same as `broadcast` (enters `history`, a third device connecting later
 * sees it in the replay), just skips one socket — used by the synthetic
 * `user_prompt` in `runTurn`, which shouldn't go back to whoever already
 * has the bubble locally. */
export function broadcastExcept(clients: Iterable<WebSocket>, history: BroadcastMessage[], message: BroadcastMessage, exclude: WebSocket): void {
  history.push(message);
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client !== exclude) client.send(payload);
  }
}
