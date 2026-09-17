// Claude's AgentSessionDriver — the MCP-bridge registration, --mcp-config
// assembly, and raw-ClaudeEvent-to-AgentEvent mapping that used to live
// inside SharedSession.runTurn/performEdit, moved here verbatim (mechanical
// extraction, not a rewrite) now that runtimes/sessionDriver.ts gives it a
// home. SharedSession stays agent-agnostic: it only ever calls
// AgentSessionDriver methods, never anything Claude-CLI-shaped directly.
import { defaultCwd } from "../../../host/paths.js";
import type { McpChoiceBridge } from "../../../bridges/mcpBridge.js";
import type { McpPermissionBridge } from "../../../bridges/permissionBridge.js";
import type { AgentEvent } from "../../../protocol/agent-event.js";
import type { AgentSessionDriver, DriverTurnResult, SessionDriverHost } from "../../sessionDriver.js";
import type { TurnContext } from "../../types.js";
import { ClaudeSession, toClaudeMode } from "./session.js";
import { transcriptPath } from "./transcriptReader.js";
import { forkTruncatedTranscript } from "./transcriptFork.js";
import { buildMcpSpawnConfig } from "./mcpSpawnConfig.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";

/** Bridge wiring shared by every `SharedSession` in the process (mirrors
 * what `SharedSessionOptions` already carried) — `undefined` fields mean
 * "this test/context doesn't exercise that bridge," same as before this
 * extraction, not a Codex-vs-Claude distinction (Codex never constructs a
 * `ClaudeSessionDriver` at all). */
export interface ClaudeMcpWiring {
  readonly choiceBridge?: McpChoiceBridge;
  readonly bridgeBaseUrl?: string;
  readonly permissionBridge?: McpPermissionBridge;
  readonly permissionBridgeBaseUrl?: string;
}

export interface ClaudeSessionDriverOptions {
  readonly homeOverride?: string;
  readonly initialSessionId?: string;
  readonly host: SessionDriverHost;
  readonly mcp?: ClaudeMcpWiring;
}

export class ClaudeSessionDriver implements AgentSessionDriver {
  private readonly claudeSession: ClaudeSession;
  private readonly homeOverride: string | undefined;
  private readonly host: SessionDriverHost;
  private readonly mcp: ClaudeMcpWiring | undefined;

  constructor(options: ClaudeSessionDriverOptions) {
    this.claudeSession = new ClaudeSession({ homeOverride: options.homeOverride, initialSessionId: options.initialSessionId });
    this.homeOverride = options.homeOverride;
    this.host = options.host;
    this.mcp = options.mcp;
  }

  getSessionId(): string | undefined {
    return this.claudeSession.getSessionId();
  }

  setSessionId(sessionId: string): void {
    this.claudeSession.setSessionId(sessionId);
  }

  resetSessionId(): void {
    this.claudeSession.resetSessionId();
  }

  stop(): boolean {
    return this.claudeSession.stop();
  }

  /** Nothing outlives a single turn for a spawn-per-turn CLI — each turn is
   * its own process, already reaped by the time `sendTurn` resolves. */
  dispose(): void {}

  async sendTurn(ctx: TurnContext, onEvent: (event: AgentEvent) => void): Promise<DriverTurnResult> {
    const permissionMode = toClaudeMode(ctx.permissionModeId);
    // Registered fresh for every turn (not once per session): the token is
    // the endpoint's only auth, and a turn that ends (however it ends —
    // success, error, or `stop()`) must not leave a token alive that a
    // since-exited `claude` child could no longer call anyway. Only built
    // outside `plan` mode: the CLI blocks any non-native tool categorically
    // there regardless of `--allowedTools` — passing this would be dead
    // weight on every spawn.
    const choiceRegistration =
      this.mcp?.choiceBridge && permissionMode !== "plan"
        ? this.mcp.choiceBridge.registerTurn({ presentChoice: (questions) => this.host.presentChoice(questions) })
        : undefined;
    // Only skipped in `bypassPermissions`, the one mode whose entire point
    // is "don't ask". Merged below with `choiceRegistration` into a single
    // `--mcp-config` when both are active (every mode except
    // `bypassPermissions` — `plan` only gets this one, `default`/`acceptEdits`
    // get both): validated against the real binary that `--allowedTools` and
    // `--permission-prompt-tool` coexist fine in the same spawn.
    const permissionRegistration =
      this.mcp?.permissionBridge && permissionMode !== "bypassPermissions"
        ? this.mcp.permissionBridge.registerTurn({
            checkPermission: (toolName, input, toolUseId) => this.host.checkPermission(toolName, input, toolUseId),
          })
        : undefined;
    // The actual CLI-arg assembly (which servers, which flags, the known-
    // ineffective idle-timeout override, the alwaysLoad fix) is pure and
    // lives in `buildMcpSpawnConfig` (mcpSpawnConfig.ts) — this is only the
    // "which mode gets which bridge" decision, which needs `permissionMode`.
    const mcpConfig = buildMcpSpawnConfig({
      choiceToken: choiceRegistration?.token,
      permissionToken: permissionRegistration?.token,
      mcpBridgeBaseUrl: this.mcp?.bridgeBaseUrl,
      mcpPermissionBridgeBaseUrl: this.mcp?.permissionBridgeBaseUrl,
      // `choiceRegistration !== undefined` mirrors "present_choice
      // registered as AskUserQuestion's replacement"; `permissionMode ===
      // "plan"` is the extra case where present_choice can't be registered
      // (the CLI blocks it there) but the native tool still needs blocking
      // so the model falls back to the plan-mode text-marker convention
      // instead of a dead tool call. The two clauses are mutually exclusive
      // given `choiceRegistration`'s own `permissionMode !== "plan"` gate
      // above, but left as an OR so this stays correct if that gate ever
      // changes.
      blockAskUserQuestion: permissionMode === "plan" || choiceRegistration !== undefined,
    });

    try {
      const { stopped, contextUsage, lastAssistantText } = await this.claudeSession.sendTurn(
        ctx.prompt,
        ctx.cwd,
        permissionMode,
        ctx.modelId,
        (event) => {
          for (const agentEvent of mapClaudeEvent(event)) onEvent(agentEvent);
        },
        mcpConfig,
      );
      return { stopped, contextUsage, lastAssistantText };
    } finally {
      choiceRegistration?.unregister();
      permissionRegistration?.unregister();
    }
  }

  /** `SharedSession.editMessage` only calls this when `getSessionId()` is
   * already truthy (its own guard, same as before this extraction) — a
   * session with turns to rewind but no session id is the "first real turn
   * failed before any result" case, which never reaches here. */
  rewind(turnsBefore: number, cwd: string): Promise<string> {
    const sessionId = this.claudeSession.getSessionId();
    if (!sessionId) return Promise.reject(new Error("ClaudeSessionDriver.rewind called with no sessionId to rewind from"));
    const home = defaultCwd(this.homeOverride);
    const path = transcriptPath(home, cwd, sessionId);
    const newSessionId = forkTruncatedTranscript(path, turnsBefore);
    this.claudeSession.setSessionId(newSessionId);
    return Promise.resolve(newSessionId);
  }
}
