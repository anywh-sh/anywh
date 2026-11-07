// Signs Claude Code in to one of its MCP servers through its control
// protocol (the def's `mcp.auth`, `control-request`): one turnless process
// per sign-in, alive for the whole flow, since the PKCE state the callback
// is checked against lives in it. A claude.ai connector is not signed in
// here at all: it is authorized on claude.ai, and checked again in a new
// process (one started before the authorization may never see it).
import { ClaudeControlError, claudeControlArgs, startClaudeControl, type ClaudeControlOptions, type ClaudeControlProcess } from "../claudeControl.js";
import { parseClaudeMcpStatus } from "../inventory/claude.js";
import type { AgentRuntimeDef, McpAuthContract } from "../../runtimes/types.js";
import type { McpInventoryEntry } from "../types.js";
import { MCP_OAUTH_REDIRECT_URI, stateOfUrl, type AuthDriver, type AuthSession, type AuthStartMode } from "./engine.js";

/** How long the process may take to load the new token and connect. */
export const CLAUDE_AUTH_CONNECT_MS = 10_000;
const STATUS_POLL_MS = 500;

export interface ClaudeAuthOptions {
  readonly def: AgentRuntimeDef;
  readonly homeOverride?: string;
  /** Where a server every session has is signed in from (no project's). */
  readonly neutralCwd: string;
  /** How long a fresh process may take for its servers to settle. */
  readonly settleMs?: number;
  readonly connectMs?: number;
  /** Defaults to `startClaudeControl`. */
  readonly start?: (options: ClaudeControlOptions) => ClaudeControlProcess;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `mcp_authenticate`'s answer, as far as the flow needs it. */
export interface ClaudeAuthenticateReply {
  readonly authUrl: string;
  readonly mode: "deeplink" | "localhost" | "claudeai";
  readonly state?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `{authUrl, requiresUserAction, callbackExpected, redirectScheme:
 * "custom"|"localhost", state, callbackPort?}` (2.1.303), or `undefined`. A
 * reply that expects no callback is a claude.ai connector's. */
export function parseAuthenticateReply(reply: unknown): ClaudeAuthenticateReply | undefined {
  if (!isRecord(reply) || typeof reply.authUrl !== "string" || reply.authUrl === "") return undefined;
  const state = typeof reply.state === "string" && reply.state !== "" ? reply.state : stateOfUrl(reply.authUrl);
  const mode = reply.callbackExpected === false ? "claudeai" : reply.redirectScheme === "custom" ? "deeplink" : "localhost";
  return { authUrl: reply.authUrl, mode, ...(state && mode !== "claudeai" ? { state } : {}) };
}

/** The server's status in an `mcp_status` reply. */
export function statusIn(reply: unknown, serverName: string): string | undefined {
  return parseClaudeMcpStatus(reply)?.find((server) => server.name === serverName)?.status;
}

export class ClaudeAuthDriver implements AuthDriver {
  private readonly contract: Extract<McpAuthContract, { kind: "control-request" }>;
  private readonly args: readonly string[];
  private readonly statusSubtype: string;
  private readonly start: (options: ClaudeControlOptions) => ClaudeControlProcess;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClaudeAuthOptions) {
    const { mcp } = options.def.portability;
    const args = claudeControlArgs(options.def);
    if (mcp.kind !== "supported" || mcp.auth?.kind !== "control-request" || !args) throw new Error(`claude auth: def "${options.def.identity.id}" declares no control-request sign-in`);
    this.contract = mcp.auth;
    this.args = args;
    this.statusSubtype = mcp.inventory?.kind === "control-request" ? mcp.inventory.subtype : "mcp_status";
    this.start = options.start ?? startClaudeControl;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async begin(entry: McpInventoryEntry, mode: AuthStartMode): Promise<AuthSession> {
    const process = this.spawn(entry);
    try {
      const reply = parseAuthenticateReply(
        await process.request(this.contract.authenticate, { serverName: entry.name, ...(mode === "deeplink" ? { redirectUri: MCP_OAUTH_REDIRECT_URI } : {}) }),
      );
      if (!reply) throw new Error("the CLI gave no sign-in address");
      if (reply.mode === "claudeai") {
        // Nothing to keep this process for: the connector is authorized on
        // claude.ai, and only a new process sees it.
        process.close();
        return { authUrl: reply.authUrl, mode: "claudeai", recheck: () => this.recheck(entry), close: () => {} };
      }
      return {
        authUrl: reply.authUrl,
        mode: reply.mode,
        ...(reply.state ? { state: reply.state } : {}),
        complete: (callbackUrl) => this.complete(process, entry, callbackUrl),
        close: () => process.close(),
      };
    } catch (error) {
      process.close();
      throw error instanceof ClaudeControlError ? new Error(error.message) : error;
    }
  }

  private spawn(entry: McpInventoryEntry): ClaudeControlProcess {
    return this.start({ def: this.options.def, args: this.args, cwd: entry.cwd ?? this.options.neutralCwd, ...(this.options.homeOverride !== undefined ? { homeOverride: this.options.homeOverride } : {}) });
  }

  /** The exchange, then the reconnect the process needs to load the token
   * (submitting alone leaves it `needs-auth` there), then its word that the
   * server connected. */
  private async complete(process: ClaudeControlProcess, entry: McpInventoryEntry, callbackUrl: string): Promise<void> {
    await process.request(this.contract.submitCallback, { serverName: entry.name, callbackUrl });
    await process.request(this.contract.reconnect, { serverName: entry.name });
    const deadline = Date.now() + (this.options.connectMs ?? CLAUDE_AUTH_CONNECT_MS);
    for (;;) {
      const status = statusIn(await process.request(this.statusSubtype), entry.name);
      if (status === "connected") return;
      if (Date.now() >= deadline) throw new Error(`signed in, but ${entry.name} did not connect (${status ?? "absent"})`);
      await this.sleep(STATUS_POLL_MS);
    }
  }

  /** A connector authorized on claude.ai, as a new process sees it once its
   * servers settled. */
  private async recheck(entry: McpInventoryEntry): Promise<boolean> {
    const process = this.spawn(entry);
    try {
      const deadline = Date.now() + (this.options.settleMs ?? 8000);
      for (;;) {
        const status = statusIn(await process.request(this.statusSubtype), entry.name);
        if (status === "connected") return true;
        if (status !== "pending" || Date.now() >= deadline) return false;
        await this.sleep(STATUS_POLL_MS);
      }
    } finally {
      process.close();
    }
  }
}
