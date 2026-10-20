// The spec the agent host starts a room agent's long-lived `claude` with: the
// turn's own choices (cwd, model, effort, permission mode) plus the room's
// wiring — its instructions and the relay's `anywh-room` MCP server.
//
// Pure: builds data the host turns into argv (`persistent.ts`).
import type { RoomAgentSetup, TurnContext } from "../../types.js";
import type { PersistentClaudeSpec } from "./persistent.js";
import { toClaudeMode } from "./session.js";

export interface ClaudeHostSpec extends PersistentClaudeSpec {
  readonly cwd: string;
  /** `--mcp-config` payload (the host writes it to a private file). */
  readonly mcpConfigJson?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** The only built-in tools a room's principal has. */
export const PRINCIPAL_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Denied to the principal on top of `--tools`, in case a CLI version
 * ignores that flag: anything that writes, runs commands, leaves the machine,
 * or starts a native subagent. */
export const PRINCIPAL_DENIED_TOOLS = ["Agent", "Task", "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "AskUserQuestion"] as const;

/** Native subagents inside a worker: at most 5 at once, and they cannot
 * start their own. */
export const WORKER_SUBAGENT_LIMITS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "5",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
};

/** `mcp__<server>__<tool>`, the name the CLI gives an MCP tool. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function buildClaudeHostSpec(ctx: TurnContext, setup: RoomAgentSetup | undefined): ClaudeHostSpec {
  const base: ClaudeHostSpec = {
    cwd: ctx.cwd,
    ...(ctx.modelId ? { model: ctx.modelId } : {}),
    ...(ctx.effortId ? { effort: ctx.effortId } : {}),
    permissionMode: toClaudeMode(ctx.permissionModeId),
    // A room agent works for another agent: the user's MCP servers, none of
    // their personal plugins, skills or hooks (agentWorker.ts).
    agentWorker: true,
  };
  if (!setup) return base;
  const roomTools = setup.tools.map((tool) => mcpToolName(setup.bridgeServerName, tool.name));
  const wiring = {
    ...base,
    appendSystemPrompt: setup.instructions,
    // `alwaysLoad`: the tools arrive with their schema, never deferred behind
    // a tool search (the same fix the choice bridge needed).
    mcpConfigJson: JSON.stringify({ mcpServers: { [setup.bridgeServerName]: { type: "http", url: setup.bridgeUrl, alwaysLoad: true } } }),
  };
  if (setup.role === "principal") {
    return {
      ...wiring,
      // Read-only by construction, whatever its permission mode: only these
      // built-ins exist for it at all (`--tools`), the rest is denied on top
      // (a native subagent would take delegation away from the room), and no
      // MCP server but the room's is loaded.
      tools: PRINCIPAL_TOOLS.join(","),
      disallowedTools: PRINCIPAL_DENIED_TOOLS.join(","),
      allowedTools: [...PRINCIPAL_TOOLS, ...roomTools].join(","),
      strictMcp: true,
    };
  }
  return {
    ...wiring,
    allowedTools: roomTools.join(","),
    // A worker may parallelize its own task with native subagents, bounded:
    // a few at once, none of them spawning more.
    env: WORKER_SUBAGENT_LIMITS,
  };
}
