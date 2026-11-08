// Calls one tool of one MCP server through the CLI that declares it, the way
// the def's `toolCall` contract says — no turn, no model call:
// - Claude: `mcp_call` on a turnless process. First on a process isolated
//   to that one server (`--strict-mcp-config`, booting one server instead
//   of every one of the profile), checked with `mcp_status` before the call;
//   when the server does not come up connected there (a sign-in that does
//   not carry over to a server declared that way), on the ordinary process
//   of the shared pool instead, and from then on for that server.
// - Codex: `mcpServer/tool/call` on the control daemon's thread.
//
// Never rejects: every failure is a `ToolCallOutcome`. Logs say which
// server and tool, never arguments or results.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeDef, McpToolCallContract } from "../runtimes/types.js";
import { claudeControlArgs, startClaudeControl, type ClaudeControlPool, type ClaudeControlProcess } from "./claudeControl.js";
import type { CodexControl } from "./codexControl.js";
import { readCallToolResult, transportFailure, type ToolCallOutcome } from "./toolResult.js";
import type { McpInventoryEntry, McpRuntimeId } from "./types.js";

export const TOOL_CALL_TIMEOUT_MS = 20_000;
export const ISOLATED_IDLE_MS = 5 * 60 * 1000;
/** How long an isolated process may take to bring its one server up. */
export const ISOLATED_SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 500;

/** Calls a tool of a server the inventory knows. */
export interface McpToolCaller {
  call(server: McpInventoryEntry, tool: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  close(): void;
}

export interface RuntimeToolCallerOptions {
  readonly defs: readonly AgentRuntimeDef[];
  readonly homeOverride?: string;
  /** Shared with the inventory: the ordinary Claude processes. */
  readonly claudePool?: ClaudeControlPool;
  readonly codexControl?: CodexControl;
  readonly neutralCwd?: string;
  readonly timeoutMs?: number;
  readonly isolatedIdleMs?: number;
  readonly settleMs?: number;
  /** Defaults to `startClaudeControl`. */
  readonly startClaude?: typeof startClaudeControl;
}

interface Isolated {
  readonly process: ClaudeControlProcess;
  readonly dir: string;
  idle: NodeJS.Timeout;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class RuntimeToolCaller implements McpToolCaller {
  private readonly defs = new Map<McpRuntimeId, { def: AgentRuntimeDef; contract: McpToolCallContract }>();
  private readonly isolated = new Map<string, Promise<Isolated | undefined>>();
  /** Servers whose isolated process did not work: the ordinary one is used. */
  private readonly notIsolated = new Set<string>();
  private readonly timeoutMs: number;
  private readonly neutralCwd: string;
  private closed = false;

  constructor(private readonly options: RuntimeToolCallerOptions) {
    this.timeoutMs = options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS;
    this.neutralCwd = options.neutralCwd ?? tmpdir();
    for (const def of options.defs) {
      const { mcp } = def.portability;
      const id = def.identity.id;
      if ((id === "claude" || id === "codex") && mcp.kind === "supported" && mcp.toolCall) this.defs.set(id, { def, contract: mcp.toolCall });
    }
  }

  async call(server: McpInventoryEntry, tool: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const runtime = this.defs.get(server.runtimeId);
    if (!runtime || this.closed) return { ok: false, kind: "transport", message: `${server.runtimeId} cannot call MCP tools` };
    const { def, contract } = runtime;
    if (contract.kind === "control-request") return this.callClaude(def, contract, server, tool, args);
    return this.callCodex(contract, server, tool, args);
  }

  /** Drops the processes started for single servers (and what was learnt
 * about which ones cannot be isolated): the next call starts afresh, with
 * whatever tokens the CLI has now. */
  reset(): void {
    // A call already on its way still gets its answer.
    for (const pending of this.isolated.values()) void pending.then((isolated) => isolated && this.stopIsolated(isolated, true));
    this.isolated.clear();
    this.notIsolated.clear();
  }

  close(): void {
    this.closed = true;
    for (const pending of this.isolated.values()) void pending.then((isolated) => isolated && this.stopIsolated(isolated));
    this.isolated.clear();
  }

  // --- Claude ----------------------------------------------------------------

  private async callClaude(
    def: AgentRuntimeDef,
    contract: Extract<McpToolCallContract, { kind: "control-request" }>,
    server: McpInventoryEntry,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const payload = contract.payload(server.name, tool, args);
    const key = `${server.name}\u0000${server.cwd ?? ""}\u0000${JSON.stringify(server.claudeConfig ?? null)}`;
    if (server.claudeConfig !== undefined && !this.notIsolated.has(key)) {
      const isolated = await this.isolatedFor(key, def, contract, server);
      if (isolated) {
        this.touch(key, isolated);
        try {
          return readCallToolResult(await isolated.process.request(contract.subtype, payload, this.timeoutMs));
        } catch (error) {
          // The isolated process itself failed (not the tool): the next call
          // starts a new one; this one is answered by the ordinary process.
          this.dropIsolated(key, isolated);
          console.warn(`[relay] MCP tool call: isolated ${server.name} failed (${(error as Error).name}), using the shared process`);
        }
      } else {
        this.notIsolated.add(key);
        console.warn(`[relay] MCP tool call: ${server.name} does not come up on its own; using the shared process`);
      }
    }
    const pool = this.options.claudePool;
    if (!pool) return { ok: false, kind: "transport", message: "no claude control process" };
    try {
      return readCallToolResult(await pool.request(server.cwd, contract.subtype, payload, { timeoutMs: this.timeoutMs }));
    } catch (error) {
      return transportFailure(error);
    }
  }

  private isolatedFor(key: string, def: AgentRuntimeDef, contract: Extract<McpToolCallContract, { kind: "control-request" }>, server: McpInventoryEntry): Promise<Isolated | undefined> {
    const existing = this.isolated.get(key);
    if (existing) return existing;
    const started = this.startIsolated(key, def, contract, server).catch(() => undefined);
    this.isolated.set(key, started);
    void started.then((isolated) => {
      if (!isolated && this.isolated.get(key) === started) this.isolated.delete(key);
    });
    return started;
  }

  private async startIsolated(key: string, def: AgentRuntimeDef, contract: Extract<McpToolCallContract, { kind: "control-request" }>, server: McpInventoryEntry): Promise<Isolated | undefined> {
    const base = claudeControlArgs(def);
    const { mcp } = def.portability;
    const parse = mcp.kind === "supported" && mcp.inventory?.kind === "control-request" ? mcp.inventory.parse : undefined;
    const statusSubtype = mcp.kind === "supported" && mcp.inventory?.kind === "control-request" ? mcp.inventory.subtype : undefined;
    if (!base || !parse || !statusSubtype) return undefined;
    // Holds no secret (a connector's id, a URL), but is nobody else's.
    const dir = mkdtempSync(join(tmpdir(), "anywh-mcp-call-"));
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify(contract.isolatedConfig(server.name, server.claudeConfig)), { mode: 0o600 });
    const start = this.options.startClaude ?? startClaudeControl;
    // Set once the server came up; the process may end before that.
    const started: { isolated?: Isolated } = {};
    const child = start({
      def,
      args: [...base, ...contract.isolatedArgs(configPath)],
      cwd: server.cwd ?? this.neutralCwd,
      ...(this.options.homeOverride !== undefined ? { homeOverride: this.options.homeOverride } : {}),
      onExit: () => {
        rmSync(dir, { recursive: true, force: true });
        if (started.isolated) this.dropIsolated(key, started.isolated);
      },
    });
    const deadline = Date.now() + (this.options.settleMs ?? ISOLATED_SETTLE_MS);
    try {
      for (;;) {
        const reports = parse(await child.request(statusSubtype, {}, this.timeoutMs));
        const status = reports?.find((report) => report.name === server.name)?.status;
        if (status === "connected") break;
        if (status !== "pending" || Date.now() >= deadline || this.closed) {
          child.close();
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
    } catch {
      child.close();
      return undefined;
    }
    started.isolated = { process: child, dir, idle: this.idleTimer(key) };
    return started.isolated;
  }

  private idleTimer(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.isolated.get(key)?.then((isolated) => isolated && this.dropIsolated(key, isolated));
    }, this.options.isolatedIdleMs ?? ISOLATED_IDLE_MS);
    timer.unref();
    return timer;
  }

  private touch(key: string, isolated: Isolated): void {
    clearTimeout(isolated.idle);
    isolated.idle = this.idleTimer(key);
  }

  private dropIsolated(key: string, isolated: Isolated): void {
    void this.isolated.get(key)?.then((current) => {
      if (current === isolated) this.isolated.delete(key);
    });
    this.stopIsolated(isolated);
  }

  /** `drain`: once it answered what it was asked (its folder goes when it
   * exits). */
  private stopIsolated(isolated: Isolated, drain = false): void {
    clearTimeout(isolated.idle);
    if (drain) {
      isolated.process.closeWhenIdle();
      return;
    }
    isolated.process.close();
    rmSync(isolated.dir, { recursive: true, force: true });
  }

  // --- Codex -----------------------------------------------------------------

  private async callCodex(contract: Extract<McpToolCallContract, { kind: "app-server" }>, server: McpInventoryEntry, tool: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const control = this.options.codexControl;
    if (!control) return { ok: false, kind: "transport", message: "no codex control daemon" };
    // The control daemon runs in the neutral folder: a project's own server
    // is not on its thread.
    if (server.cwd !== undefined) return { ok: false, kind: "transport", message: "a project's own Codex server cannot be called from outside it" };
    try {
      const result = await control.requestOnThread(contract.method, (threadId) => contract.params(threadId, server.name, tool, args));
      return readCallToolResult(isRecord(result) ? result : { content: [] });
    } catch (error) {
      return transportFailure(error);
    }
  }
}
