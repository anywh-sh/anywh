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
  return {
    ...base,
    appendSystemPrompt: setup.instructions,
    // `alwaysLoad`: the tools arrive with their schema, never deferred behind
    // a tool search (the same fix the choice bridge needed).
    mcpConfigJson: JSON.stringify({ mcpServers: { [setup.bridgeServerName]: { type: "http", url: setup.bridgeUrl, alwaysLoad: true } } }),
    allowedTools: roomTools.join(","),
  };
}
