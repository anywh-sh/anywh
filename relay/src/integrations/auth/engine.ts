// Signing a profile's agent CLIs in to their MCP servers, from the app: one
// queue per profile (this process), one sign-in running at a time — two at
// once can collide on a CLI's callback port, and a person follows one
// browser tab at a time anyway. Each sign-in is a flow the client shows as
// a card (`mcp_auth_flow`), driven by the runtime's own OAuth through its
// `AuthDriver` (auth/claude.ts, auth/codex.ts); the relay never sees a
// token.
//
// A flow ends one way: done (the CLI says the server is connected), failed
// (the CLI refused, or nobody finished within `timeoutMs` — the CLIs keep
// no timer of their own once the browser comes back through the app's
// link), or cancelled. On done, `onSignedIn` lets the relay's other
// processes of that CLI load the new token and the inventory rescan.
import { randomUUID } from "node:crypto";
import type { McpAuthFlow, McpAuthFlowMode, McpAuthTarget, McpInventoryEntry, McpRuntimeId } from "../types.js";

/** The app's own link a browser comes back to after a sign-in. */
export const MCP_OAUTH_REDIRECT_URI = "anywh://mcp-oauth/callback";
/** How long a sign-in may wait for the person. */
export const MCP_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const MCP_AUTH_TIMEOUT_ENV = "ANYWH_MCP_AUTH_TIMEOUT_MS";
/** A claude.ai connector is looked at again this often, this long, after
 * the person says they authorized it. */
export const MCP_AUTH_RECHECK_INTERVAL_MS = 3000;
export const MCP_AUTH_RECHECK_WINDOW_MS = 2 * 60 * 1000;
export const MCP_AUTH_RECHECK_WINDOW_ENV = "ANYWH_MCP_AUTH_RECHECK_WINDOW_MS";
/** Finished flows kept to show a client that connects later. */
const KEPT_FINISHED = 20;

/** How a sign-in is asked to come back: through the app's link, or to the
 * CLI's loopback listener (the address then pasted back). */
export type AuthStartMode = "deeplink" | "localhost";

/** One sign-in a runtime started. */
export interface AuthSession {
  readonly authUrl: string;
  /** Can differ from the mode asked for: a server that refuses the app's
   * link is signed in on loopback, a claude.ai connector on claude.ai. */
  readonly mode: McpAuthFlowMode;
  /** The OAuth `state` of `authUrl`; a callback must carry the same. */
  readonly state?: string;
  /** Hands over the address the browser ended on. Resolves once the server
   * is signed in; rejects with the CLI's reason. */
  complete?(callbackUrl: string): Promise<void>;
  /** For a connector authorized elsewhere: whether it is signed in now. */
  recheck?(): Promise<boolean>;
  /** Ends whatever the sign-in holds open. Idempotent. */
  close(): void;
}

export interface AuthDriver {
  begin(entry: McpInventoryEntry, mode: AuthStartMode): Promise<AuthSession>;
}

/** The `state` query parameter of a URL. */
export function stateOfUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

export type CallbackCheck = "ok" | "not_url" | "missing_code" | "state_mismatch";

/** Whether an address is the end of the sign-in whose `state` is given: a
 * URL with a `code` (or the provider's `error`) and the same `state`. */
export function checkCallback(callbackUrl: string, state: string | undefined): CallbackCheck {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    return "not_url";
  }
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return "missing_code";
  if (state !== undefined && url.searchParams.get("state") !== state) return "state_mismatch";
  return "ok";
}

export type CompleteOutcome = CallbackCheck | "unknown_flow" | "not_waiting";

export interface McpAuthEngineOptions {
  readonly drivers: Partial<Record<McpRuntimeId, AuthDriver>>;
  /** The inventory's entry for a target, if it has one. */
  readonly entryOf: (target: McpAuthTarget) => McpInventoryEntry | undefined;
  /** A server got signed in. Must not throw. */
  readonly onSignedIn?: (entry: McpInventoryEntry) => void;
  readonly timeoutMs?: number;
  readonly recheckIntervalMs?: number;
  readonly recheckWindowMs?: number;
  readonly timers?: { readonly set: (callback: () => void, ms: number) => unknown; readonly clear: (handle: unknown) => void };
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** A non-negative integer of ms from `env[name]`, else `fallback`. */
export function msFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

interface FlowSlot {
  flow: McpAuthFlow;
  readonly startMode: AuthStartMode;
  entry?: McpInventoryEntry;
  session?: AuthSession;
  timer?: unknown;
  rechecking?: boolean;
}

const FINISHED = new Set<McpAuthFlow["phase"]>(["done", "failed", "cancelled"]);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class McpAuthEngine {
  private readonly slots = new Map<string, FlowSlot>();
  private readonly listeners = new Set<(flow: McpAuthFlow) => void>();
  private active: FlowSlot | undefined;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: McpAuthEngineOptions) {
    this.timeoutMs = options.timeoutMs ?? MCP_AUTH_TIMEOUT_MS;
    this.setTimer = options.timers?.set ?? ((callback, ms) => setTimeout(callback, ms).unref());
    this.clearTimer = options.timers?.clear ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Every flow still going, then the latest finished ones. */
  flows(): McpAuthFlow[] {
    return [...this.slots.values()].map((slot) => ({ ...slot.flow }));
  }

  subscribe(listener: (flow: McpAuthFlow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queues a sign-in per target, in order; a target already queued or
   * waiting keeps its flow. Returns the targets' flows. */
  start(targets: readonly McpAuthTarget[], mode: AuthStartMode = "deeplink"): McpAuthFlow[] {
    const flows: McpAuthFlow[] = [];
    for (const target of targets) {
      const existing = [...this.slots.values()].find((slot) => !FINISHED.has(slot.flow.phase) && slot.flow.runtimeId === target.runtimeId && slot.flow.serverName === target.serverName);
      if (existing) {
        flows.push({ ...existing.flow });
        continue;
      }
      const slot: FlowSlot = {
        flow: { flowId: this.options.newId?.() ?? randomUUID(), runtimeId: target.runtimeId, serverName: target.serverName, phase: "queued", mode },
        startMode: mode,
      };
      this.slots.set(slot.flow.flowId, slot);
      this.emit(slot);
      flows.push({ ...slot.flow });
    }
    this.trimFinished();
    this.pump();
    return flows;
  }

  /** The address the browser ended on, for the flow waiting for it. A
   * callback for another sign-in is refused and leaves the flow waiting;
   * the provider's `error` ends it. */
  complete(flowId: string, callbackUrl: string): CompleteOutcome {
    const slot = this.slots.get(flowId);
    if (!slot) return "unknown_flow";
    const { session } = slot;
    if (slot !== this.active || slot.flow.phase !== "awaiting_user" || !session?.complete) return "not_waiting";
    const check = checkCallback(callbackUrl, slot.flow.state);
    if (check !== "ok") {
      this.update(slot, { error: check });
      return check;
    }
    const providerError = new URL(callbackUrl.trim()).searchParams.get("error");
    if (providerError) {
      this.finish(slot, "failed", providerError);
      return "ok";
    }
    this.update(slot, { phase: "completing", error: undefined });
    session.complete(callbackUrl.trim()).then(
      () => this.finish(slot, "done"),
      (error: unknown) => this.finish(slot, "failed", errorMessage(error)),
    );
    return "ok";
  }

  /** For a claude.ai connector: looks again, a few times, whether it is
   * signed in now. Still not: the flow keeps waiting, saying so. */
  recheck(flowId: string): boolean {
    const slot = this.slots.get(flowId);
    const session = slot?.session;
    if (!slot || slot !== this.active || slot.flow.phase !== "awaiting_user" || !session?.recheck || slot.rechecking) return false;
    slot.rechecking = true;
    this.update(slot, { error: undefined });
    const interval = this.options.recheckIntervalMs ?? MCP_AUTH_RECHECK_INTERVAL_MS;
    const window = this.options.recheckWindowMs ?? MCP_AUTH_RECHECK_WINDOW_MS;
    const now = this.options.now ?? Date.now;
    const until = now() + window;
    const attempt = (): void => {
      if (this.active !== slot || slot.flow.phase !== "awaiting_user") return;
      session.recheck?.().then(
        (signedIn) => {
          if (this.active !== slot || slot.flow.phase !== "awaiting_user") return;
          if (signedIn) {
            slot.rechecking = false;
            this.finish(slot, "done");
          } else if (now() + interval > until) {
            slot.rechecking = false;
            this.update(slot, { error: "not_authorized" });
          } else {
            this.setTimer(attempt, interval);
          }
        },
        (error: unknown) => {
          slot.rechecking = false;
          if (this.active === slot) this.update(slot, { error: errorMessage(error) });
        },
      );
    };
    attempt();
    return true;
  }

  cancel(flowId: string): boolean {
    const slot = this.slots.get(flowId);
    if (!slot || FINISHED.has(slot.flow.phase)) return false;
    this.finish(slot, "cancelled");
    return true;
  }

  close(): void {
    this.closed = true;
    for (const slot of this.slots.values()) {
      if (slot.timer !== undefined) this.clearTimer(slot.timer);
      slot.session?.close();
    }
    this.listeners.clear();
  }

  // --- the queue -----------------------------------------------------------

  private pump(): void {
    if (this.active || this.closed) return;
    const next = [...this.slots.values()].find((slot) => slot.flow.phase === "queued");
    if (!next) return;
    this.active = next;
    // The whole sign-in, from its start: the CLIs keep no timer once the
    // browser comes back through the app's link.
    next.timer = this.setTimer(() => {
      if (this.active === next && !FINISHED.has(next.flow.phase)) this.finish(next, "failed", "timeout");
    }, this.timeoutMs);
    const target = { runtimeId: next.flow.runtimeId, serverName: next.flow.serverName };
    const entry = this.options.entryOf(target);
    const driver = this.options.drivers[target.runtimeId];
    if (!entry) return this.finish(next, "failed", "unknown_server");
    if (!driver || entry.authMode === "none") return this.finish(next, "failed", "unsupported");
    next.entry = entry;
    driver.begin(entry, next.startMode).then(
      (session) => {
        if (this.active !== next || FINISHED.has(next.flow.phase)) {
          session.close();
          return;
        }
        next.session = session;
        this.update(next, { phase: "awaiting_user", mode: session.mode, authUrl: session.authUrl, ...(session.state ? { state: session.state } : {}) });
      },
      (error: unknown) => {
        if (this.active === next && !FINISHED.has(next.flow.phase)) this.finish(next, "failed", errorMessage(error));
      },
    );
  }

  private finish(slot: FlowSlot, phase: "done" | "failed" | "cancelled", error?: string): void {
    if (FINISHED.has(slot.flow.phase)) return;
    if (slot.timer !== undefined) this.clearTimer(slot.timer);
    slot.timer = undefined;
    slot.session?.close();
    this.update(slot, { phase, error });
    this.options.log?.(`[integrations] sign-in to ${slot.flow.runtimeId}/${slot.flow.serverName}: ${phase}${error ? ` (${error})` : ""}`);
    if (phase === "done" && slot.entry) {
      try {
        this.options.onSignedIn?.(slot.entry);
      } catch (failure) {
        console.error("[relay] after a sign-in:", failure);
      }
    }
    if (this.active === slot) {
      this.active = undefined;
      this.pump();
    }
  }

  private update(slot: FlowSlot, patch: Partial<McpAuthFlow>): void {
    const next: McpAuthFlow = { ...slot.flow, ...patch };
    if (patch.error === undefined && "error" in patch) delete next.error;
    slot.flow = next;
    this.emit(slot);
  }

  private emit(slot: FlowSlot): void {
    if (this.closed) return;
    for (const listener of this.listeners) {
      try {
        listener({ ...slot.flow });
      } catch (error) {
        console.error("[relay] auth flow listener failed:", error);
      }
    }
  }

  private trimFinished(): void {
    const finished = [...this.slots.values()].filter((slot) => FINISHED.has(slot.flow.phase));
    for (const slot of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED))) this.slots.delete(slot.flow.flowId);
  }
}
