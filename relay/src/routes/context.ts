import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionManager } from "../session/sessionManager.js";
import type { SessionStore } from "../session/sessionStore.js";

/** Shared server-lifetime state a route handler needs — everything else
 * (profile-provisioning script paths, the systemctl binary override, the
 * relay's own version string...) is local to the one route module that
 * actually uses it. */
export interface RouteContext {
  readonly sessionStore: SessionStore;
  readonly sessionManager: SessionManager;
  readonly homeOverride: string | undefined;
  readonly port: number;
  readonly defaultSession: string;
}

/** Every HTTP route handler has this shape — returns `true` if it handled
 * the request (and already wrote a response), `false` to let the
 * composition root (server.ts) try the next one. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>;
