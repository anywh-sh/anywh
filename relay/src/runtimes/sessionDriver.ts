// What `session/` is allowed to know about "whichever agent CLI is driving
// this session" — never `exec.kind` directly (architecture.test.ts's
// tripwire), only this interface. Designed with a Plan pass before any of
// runtimes/createSessionDriver.ts, runtimes/defs/claude/driver.ts, or
// runtimes/defs/codexDriver.ts were written, specifically so the shape here
// wouldn't have to guess at what a second (JSON-RPC daemon) driver needs
// before one existed to check it against.
import type { AgentEvent, TurnContext, TurnHost } from "./types.js";
import type { ContextUsage } from "../session/sessionStore.js";
import type { ChoiceHost } from "../bridges/mcpBridge.js";
import type { PermissionCheckHost } from "../bridges/permissionBridge.js";

export interface DriverTurnResult {
  /** `true` only when the turn ended because a human asked to stop it —
   * never because the driver genuinely finished or errored. Mirrors
   * `ClaudeSession.sendTurn`'s existing `stopped` field verbatim; nothing
   * about its meaning changes for a driver that isn't Claude. */
  readonly stopped: boolean;
  readonly contextUsage?: ContextUsage;
  /** Text of the last assistant response — feeds the next-message
   * suggestion generator only, same as today. `undefined` if the turn
   * produced no text block (e.g. only a tool call before being interrupted). */
  readonly lastAssistantText?: string;
}

/**
 * What `SharedSession` needs from whichever agent CLI is driving a
 * session — an extraction of what `ClaudeSession` already does today
 * (`sendTurn`/`stop`/`getSessionId`/`setSessionId`/`resetSessionId`), not a
 * new design. `rewind`/`dispose` are the two genuinely new pieces Fase 10
 * needed a home for:
 *
 * - `rewind` is `undefined` for a driver whose def declares
 *   `capabilities.rewindTurn === "none"` — `SharedSession.editMessage`
 *   branches on the METHOD'S PRESENCE, never a capability string read out of
 *   the def, so a driver with nothing to rewind simply doesn't implement it
 *   rather than throwing if called.
 * - `dispose` tears down anything that outlives a single turn (a Codex
 *   daemon process) — a no-op for a driver with nothing to hold open
 *   between turns. Called once, from `SharedSession.dispose()`, never from
 *   `stop()` (which must survive to serve the next turn — invariant 3,
 *   `runtimes/README.md` §1: killing a turn never destroys the session).
 */
export interface AgentSessionDriver {
  sendTurn(ctx: TurnContext, onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult>;
  /** Interrupts the turn in progress, if any. Returns `false` if there was
   * nothing to interrupt — same contract as `ClaudeSession.stop` today. */
  stop(): boolean;
  getSessionId(): string | undefined;
  setSessionId(sessionId: string): void;
  resetSessionId(): void;
  /** Truncates continuity back to `turnsBefore` turns and resolves with the
   * new resumable id — `SharedSession.performEdit`'s transcript-fork block,
   * generalized. Present only when the driver's capabilities support it.
   * Takes `cwd` explicitly rather than tracking it internally between
   * turns: a driver's only other window into it is whatever `TurnContext`
   * the last `sendTurn` call carried, and an edit can in principle target a
   * turn from before a `cwd` change (were that ever unlocked mid-session) —
   * the caller (`SharedSession`) always knows the session's current `cwd`,
   * the driver doesn't need to remember it too. */
  rewind?(turnsBefore: number, cwd: string): Promise<string>;
  dispose(): void;
}

/** What a driver needs back from the session to route a turn-scoped
 * question or approval anywhere a human can see it. `SharedSession`
 * implements all three, backed by one `ChoiceMachine` — a bridged driver
 * (Claude) answers through `ChoiceHost`/`PermissionCheckHost` via the MCP
 * bridges; a native driver (Codex) answers through `TurnHost`, the same
 * vocabulary its def's own `handleServerRequest` already speaks. */
export interface SessionDriverHost extends ChoiceHost, PermissionCheckHost, TurnHost {}
