import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { RoomToolSpec } from "../runtimes/types.js";

// The room's tools (`delegate`, `report`, `message_agent`, `room_status`) as
// an MCP server over Streamable HTTP, served by the relay itself — the same
// hand-rolled transport as `mcpBridge.ts` (`present_choice`), validated
// against the real `claude` binary there. Codex agents reach the same tools
// through its app-server's dynamic tools; the agent host forwards those calls
// here, so there is one implementation of each tool.
//
// Every call answers at once (the tools never wait on another agent or a
// person), so no call is ever held open: a relay restart can only cut a call
// in flight, which the agent sees as a failed tool call and may retry.
//
// Auth differs from the choice bridge on purpose. A room agent is a
// long-lived process in the agent host, started once with its
// `--mcp-config`; its URL has to keep working for the agent's whole life,
// across relay restarts, so it cannot be a token minted per turn. The token is
// an HMAC of the agent's session id under a key only this relay knows (kept
// in a 0600 file beside the sessions file): stable across restarts, never
// stored per agent, and worthless once the agent is no longer a member of a
// room (`RoomToolHost.toolsFor` answers nothing for it).

export const ROOM_BRIDGE_PATH = "/room";

/** What the bridge needs from the rooms: which tools a session may call,
 * and calling one. */
export interface RoomToolHost {
  /** `undefined` when the session is not a live member of a room. */
  toolsFor(sessionId: string): readonly RoomToolSpec[] | undefined;
  callTool(sessionId: string, name: string, args: unknown): Promise<RoomToolResult>;
}

export interface RoomToolResult {
  readonly text: string;
  readonly isError: boolean;
}

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The key file's path for a sessions file: `pessoal.json` → `pessoal-room.key`. */
export function roomKeyPathFor(sessionsFile: string): string {
  return sessionsFile.endsWith(".json") ? `${sessionsFile.slice(0, -".json".length)}-room.key` : `${sessionsFile}-room.key`;
}

function loadOrCreateKey(path: string): Buffer {
  try {
    const existing = readFileSync(path);
    if (existing.length >= 32) return existing;
  } catch {
    // created below
  }
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export class RoomBridge {
  private readonly key: Buffer;
  private host: RoomToolHost | undefined;

  /** `keyPath`: where the signing key lives (created on first use). */
  constructor(
    keyPath: string,
    private readonly baseUrl: string,
  ) {
    this.key = loadOrCreateKey(keyPath);
  }

  /** Set once the rooms exist (they need the session manager, which needs
   * this bridge's URLs). */
  attach(host: RoomToolHost): void {
    this.host = host;
  }

  private tokenFor(sessionId: string): string {
    return createHmac("sha256", this.key).update(`anywh-room:${sessionId}`).digest("base64url");
  }

  /** The URL a room agent's MCP client calls. */
  urlFor(sessionId: string): string {
    return `${this.baseUrl}/${encodeURIComponent(sessionId)}/${this.tokenFor(sessionId)}`;
  }

  private verify(sessionId: string, token: string): boolean {
    const expected = Buffer.from(this.tokenFor(sessionId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Mounted at `/room/:sessionId/:token` in `server.ts`. */
  async handleRequest(sessionId: string, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.host;
    const tools = host && this.verify(sessionId, token) ? host.toolsFor(sessionId) : undefined;
    if (!host || !tools) {
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
    const { id, method, params } = message ?? {};
    if (method === "initialize") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string | undefined) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "anywh-room", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
      return;
    }
    if (method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "";
      let result: RoomToolResult;
      if (!tools.some((tool) => tool.name === name)) {
        result = { text: `Unknown tool "${name}" for this agent. Available: ${tools.map((tool) => tool.name).join(", ")}.`, isError: true };
      } else {
        try {
          result = await host.callTool(sessionId, name, params?.arguments);
        } catch (error) {
          result = { text: `The room could not run ${name}: ${(error as Error).message}`, isError: true };
        }
      }
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) } });
      return;
    }
    if (id === undefined) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
  }
}
