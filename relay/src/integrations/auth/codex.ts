// Signs codex-cli in to one of its MCP servers through the app-server's own
// OAuth (the def's `mcp.auth`, `app-server`): an app-server of its own per
// sign-in — never a session's — started with per-process overrides of where
// the browser comes back (the app's `anywh://` link, or the CLI's loopback
// default) and of the local port that answers it, so the person's
// config.toml is never written. The address the browser ended on is then
// delivered to that port as a local `GET`, which is how the CLI expects it.
import { createServer } from "node:net";
import { DECLINING_HOST } from "../codexControl.js";
import { spawnCodexDaemon, type CodexDaemon, type SpawnCodexDaemonOptions } from "../../runtimes/transports/codexDaemon.js";
import type { AgentRuntimeDef, McpAuthContract } from "../../runtimes/types.js";
import type { McpInventoryEntry } from "../types.js";
import { MCP_OAUTH_REDIRECT_URI, stateOfUrl, type AuthDriver, type AuthSession, type AuthStartMode } from "./engine.js";

/** What the CLI is told to wait for the browser, at most; the relay's own
 * flow timeout is what ends a sign-in first. */
export const CODEX_AUTH_TIMEOUT_SECS = 300;
/** How long a delivered callback may take to finish the exchange. */
export const CODEX_AUTH_COMPLETE_MS = 15_000;

export interface CodexAuthOptions {
  readonly def: AgentRuntimeDef;
  readonly homeOverride?: string;
  readonly cwd: string;
  /** Defaults to `spawnCodexDaemon`. */
  readonly spawnDaemon?: (options: SpawnCodexDaemonOptions) => Promise<CodexDaemon>;
  /** Defaults to a port the OS hands out. */
  readonly port?: () => Promise<number>;
  readonly completeMs?: number;
}

/** A port nothing listens on right now. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Where on the CLI's listener a callback goes: the path and query of the
 * address the browser ended on, whatever its scheme and host (with the
 * app's scheme the listener answers the path alone — observed on 0.154.0).
 * `undefined` for an address that is not a URL. */
export function localDelivery(callbackUrl: string, port: number): string | undefined {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return undefined;
  }
  return `http://127.0.0.1:${port}${url.pathname}${url.search}`;
}

/** A login refused because the server would not register the app's
 * redirect (a provider that only takes https or loopback ones). */
export const isInvalidRedirect = (message: string): boolean => /invalid_redirect_uri/i.test(message);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class CodexAuthDriver implements AuthDriver {
  private readonly contract: Extract<McpAuthContract, { kind: "app-server" }>;
  private readonly spawnDaemon: (options: SpawnCodexDaemonOptions) => Promise<CodexDaemon>;

  constructor(private readonly options: CodexAuthOptions) {
    const { mcp } = options.def.portability;
    if (mcp.kind !== "supported" || mcp.auth?.kind !== "app-server") throw new Error(`codex auth: def "${options.def.identity.id}" declares no app-server sign-in`);
    this.contract = mcp.auth;
    this.spawnDaemon = options.spawnDaemon ?? spawnCodexDaemon;
  }

  async begin(entry: McpInventoryEntry, mode: AuthStartMode): Promise<AuthSession> {
    try {
      return await this.login(entry, mode);
    } catch (error) {
      // The server would not take the app's link: the CLI's own loopback
      // redirect, and the address pasted back.
      if (mode === "deeplink" && isInvalidRedirect(errorMessage(error))) return this.login(entry, "localhost");
      throw error;
    }
  }

  private async login(entry: McpInventoryEntry, mode: AuthStartMode): Promise<AuthSession> {
    const port = await (this.options.port ?? freeLoopbackPort)();
    let settle: ((result: { success: boolean; error?: string }) => void) | undefined;
    const completed = new Promise<{ success: boolean; error?: string }>((resolve) => (settle = resolve));
    const daemon = await this.spawnDaemon({
      def: this.options.def,
      cwd: this.options.cwd,
      ...(this.options.homeOverride !== undefined ? { homeOverride: this.options.homeOverride } : {}),
      host: DECLINING_HOST,
      extraArgs: this.contract.callbackArgs(entry.name, port, mode === "deeplink" ? MCP_OAUTH_REDIRECT_URI : undefined),
      onNotification: (method, params) => {
        if (method !== this.contract.completed || !isRecord(params) || params.name !== entry.name) return;
        settle?.({ success: params.success === true, ...(typeof params.error === "string" ? { error: params.error } : {}) });
      },
      onExit: () => settle?.({ success: false, error: "the sign-in process exited" }),
    });
    let reply: unknown;
    try {
      reply = await daemon.request(this.contract.login, { name: entry.name, timeoutSecs: CODEX_AUTH_TIMEOUT_SECS });
    } catch (error) {
      daemon.kill();
      throw new Error(errorMessage(error), { cause: error });
    }
    const authUrl = isRecord(reply) && typeof reply.authorizationUrl === "string" ? reply.authorizationUrl : undefined;
    if (!authUrl) {
      daemon.kill();
      throw new Error("the CLI gave no sign-in address");
    }
    const state = stateOfUrl(authUrl);
    return {
      authUrl,
      mode,
      ...(state ? { state } : {}),
      complete: async (callbackUrl) => {
        const target = localDelivery(callbackUrl, port);
        if (!target) throw new Error("not a callback address");
        // The listener answers once the exchange is done; its answer is
        // not the verdict, the completion push is.
        const delivery = fetch(target, { signal: AbortSignal.timeout(this.options.completeMs ?? CODEX_AUTH_COMPLETE_MS) }).then(
          (response) => response.body?.cancel(),
          () => undefined,
        );
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          completed,
          new Promise<{ success: boolean; error?: string }>((resolve) => {
            timer = setTimeout(() => resolve({ success: false, error: "the sign-in did not complete" }), this.options.completeMs ?? CODEX_AUTH_COMPLETE_MS);
          }),
        ]);
        clearTimeout(timer);
        void delivery;
        if (!result.success) throw new Error(result.error ?? "the sign-in failed");
      },
      close: () => daemon.kill(),
    };
  }
}
