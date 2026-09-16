// A design-validation DRAFT, same status as `./codex.ts` — not exported
// from `registry.ts`, nothing imports this file. Its job is proving the
// contract survives a *second* JSON-RPC daemon whose framing differs from
// Codex's, which is exactly the case `journal/77 §6` argues matters most:
// if the relay speaks ACP as a client, every ACP-speaking agent (Zed's
// reference agents, Gemini CLI, `coder/xum` via `xum acp`, ...) becomes a
// def here for the cost of one engine, not one integration each.
//
// Method names below (`session/new`, `session/prompt`, `session/cancel`,
// `session/request_permission`) are the public Agent Client Protocol
// vocabulary (agentclientprotocol.com) — unlike codex.ts, this one *is*
// checked against a written spec, since ACP (unlike Codex's app-server
// protocol) publishes one.
import type { AgentRuntimeDef, JsonRpcRequestSpec, TurnContext, TurnHost } from "../types.js";

function startThread(_ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "session/new", params: {} };
}

function startTurn(ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "session/prompt", params: { prompt: ctx.prompt } };
}

// ACP's one server->client request in the permission surface — a single
// method carrying its own option list, closer to today's permissionBridge
// shape than Codex's two-method split.
function handleServerRequest(method: string, params: unknown, host: TurnHost): Promise<unknown> | undefined {
  if (method === "session/request_permission") {
    const { toolCall, options } = params as { toolCall: string; options: readonly { optionId: string; labelKey: string }[] };
    return host.requestApproval({
      id: crypto.randomUUID(),
      summary: toolCall,
      availableDecisions: options.map((option) => ({ id: option.optionId, labelKey: option.labelKey })),
    });
  }
  return undefined;
}

/** ACP has no settings axis of its own comparable to Codex's sandbox ×
 * approval pair — permission is a single yes/no-shaped decision per tool
 * call, not a mode chosen ahead of a turn. `undefined` here is honest
 * about that, not a placeholder for something missing. */
export const acpRuntimeDraft: AgentRuntimeDef<undefined> = {
  identity: {
    id: "acp",
    bin: "acp-agent",
    // Deliberately empty, and the one respect in which this draft can't
    // be `assertCoherent` — ACP is a transport, not an agent, so it has no
    // credential of its own to strip. A concrete def for a specific
    // ACP-speaking agent (Zed's reference agent, `xum acp`, ...) would
    // fill this in with whatever that agent's provider actually bills.
    env: { strip: [] },
    projectInstructionsFile: "AGENTS.md",
  },
  capabilities: {
    presentChoice: "none",
    approvalPrompt: "native",
    rewindTurn: "none",
    replayHistory: "none",
    backgroundJobs: "none",
    thinking: "none",
    contextUsage: "none",
  },
  continuity: { kind: "cli-resume", resumeStyle: "capture" },
  models: { kind: "session-rpc" },
  auth: { kind: "session-rpc" },
  permissions: {
    defaultModeId: "default",
    modesFor: () => [{ id: "default", labelKey: "acp.mode.default", settings: undefined, pausesForApproval: true }],
  },
  bridges: [],
  exec: {
    kind: "jsonRpcDaemon",
    // LSP-style Content-Length framing, not one-JSON-per-line like Codex
    // — the one axis that actually differs between the two JSON-RPC
    // agents drafted so far, which is the whole point of naming it
    // instead of assuming every daemon frames the same way.
    framing: "lsp-headers",
    thread: { start: startThread },
    turn: { start: startTurn, interruptMethod: "session/cancel" },
    mapNotification: () => [],
    handleServerRequest,
  },
};
