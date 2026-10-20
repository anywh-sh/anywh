import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostClient } from "../agentHost/hostClient.js";
import type { PushStore } from "../push/pushStore.js";
import type { Registry } from "../runtimes/registry.js";
import type { SessionManager } from "../session/sessionManager.js";
import type { RoomCanvasStore } from "../session/roomCanvas.js";
import type { RoomManager } from "../session/roomManager.js";
import type { SessionStore } from "../session/sessionStore.js";

/** Shared server-lifetime state a route handler needs — everything else
 * (profile-provisioning script paths, the systemctl binary override, the
 * relay's own version string...) is local to the one route module that
 * actually uses it. */
export interface RouteContext {
  readonly sessionStore: SessionStore;
  readonly sessionManager: SessionManager;
  /** Every def this relay can drive, coherence-checked at boot — the same
   * object `SessionManager` resolves a session's agent against. A route
   * that acts per runtime (profile validation asks the chosen runtime
   * whether it is logged in) resolves the id through this rather than
   * hardcoding one CLI. */
  readonly registry: Registry;
  readonly homeOverride: string | undefined;
  readonly port: number;
  readonly defaultSession: string;
  /** The push-address registry, or `null` when push is switched off for
   * this relay (`RELAY_PUSH_DISABLED=1`) — its routes then don't exist. */
  readonly pushStore: PushStore | null;
  /** The connection to this profile's agent host, kept open (and reopened)
   * for the relay's whole life; requests fail fast while it is down.
   * Absent when the relay has no profile to find a host for. */
  readonly agentHost: HostClient | undefined;
  /** Each room's canvas (layout only), persisted beside the sessions file. */
  readonly roomCanvas: RoomCanvasStore;
  readonly roomManager: RoomManager;
}

/** Every HTTP route handler has this shape — returns `true` if it handled
 * the request (and already wrote a response), `false` to let the
 * composition root (server.ts) try the next one. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>;
