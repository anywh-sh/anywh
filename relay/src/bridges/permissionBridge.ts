import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// `--permission-prompt-tool` lets an MCP tool of ours
// decide every permission-prompt approval for a `claude -p` turn, instead of
// the relay's normal headless default (auto-deny, see the comment on
// `--permission-mode` in runtimes/defs/claude/session.ts). Confirmed against the real
// binary that this is what re-enables `ExitPlanMode`
// in headless: it's not categorically removed, it only disappears when
// nobody is configured to answer approval.
//
// Wired for every mode except `bypassPermissions` (`SharedSession.runTurn`).
// Fase 4 scoped the host's policy (`SharedSession.checkPermission`) narrowly
// to only `ExitPlanMode`, everything else auto-allowed — deliberately, to
// ship the one thing actually requested first. Fase 5 widened that policy to
// ask for every tool call that reaches here, after validating against the
// real binary that the CLI itself — not the relay — already decides what
// needs approval per mode (trivial reads/Bash never reach here in `default`;
// a dangerous-looking `Bash` still reaches here even in `acceptEdits`), so
// there was no risk classification left for the relay to invent.

/** Mirrors the real `canUseTool` contract captured live:
 * the CLI calls our tool with these three fields for every
 * action that would otherwise need approval, and expects exactly one of
 * these two shapes back. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: unknown }
  | { behavior: "deny"; message: string };

export interface PermissionCheckHost {
  checkPermission(toolName: string, input: unknown, toolUseId: string | undefined): Promise<PermissionDecision>;
}

export const PERMISSION_MCP_SERVER_NAME = "anywh-permission";
const TOOL_NAME = "approve";
export const PERMISSION_PROMPT_TOOL = `mcp__${PERMISSION_MCP_SERVER_NAME}__${TOOL_NAME}`;

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description:
    "Decides whether a pending tool call is allowed to run. Called by the CLI itself for every action that " +
    "would otherwise need permission approval — never called directly by the model.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

/** Same guard as `mcpBridge.ts`'s `sendJson` — the `claude` child that made
 * this call can get SIGINT'd (turn stopped, session deleted) before our
 * `await host.checkPermission(...)` below settles. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Same minimal "Streamable HTTP" MCP transport as `McpChoiceBridge` — see
 * that class's doc comment for why this runs in-process on the relay's own
 * `httpServer` rather than as a stdio subprocess. Kept as a separate class
 * (rather than sharing plumbing with `McpChoiceBridge`) because the two
 * were validated independently against the real binary and touching the
 * already-shipped one for a shared abstraction isn't worth the risk for two
 * call sites.
 */
export class McpPermissionBridge {
  private readonly pending = new Map<string, PermissionCheckHost>();

  registerTurn(host: PermissionCheckHost): { token: string; unregister: () => void } {
    const token = randomUUID();
    this.pending.set(token, host);
    return { token, unregister: () => this.pending.delete(token) };
  }

  /** Mounted at `/permission/:token` in `server.ts`. */
  async handleRequest(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.pending.get(token);
    if (!host) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let message: JsonRpcRequest;
    try {
      message = (await readJsonBody(req)) as JsonRpcRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (method === "initialize") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: PERMISSION_MCP_SERVER_NAME, version: "1.0.0" },
        },
      });
      return;
    }

    if (method === "tools/list") {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: [TOOL_SCHEMA] } });
      return;
    }

    if (method === "tools/call" && params?.name === TOOL_NAME) {
      const args = params.arguments as { tool_name?: string; input?: unknown; tool_use_id?: string } | undefined;
      try {
        const decision = await host.checkPermission(args?.tool_name ?? "", args?.input, args?.tool_use_id);
        sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
      }
      return;
    }

    if (isNotification) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
  }
}
