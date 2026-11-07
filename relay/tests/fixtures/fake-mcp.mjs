#!/usr/bin/env node
// An MCP server that fails on purpose, for the conformance tier: how each
// REAL CLI words a server failing a tool call (the def's
// `mcp.failureClassifier`). Loopback and stdio only.
//   stdio:  node fake-mcp.mjs stdio [boot-crash]
//   http:   startFakeMcp(mode) — `401-all` or `expire-on-call` (handshake
//           fine, 401 on `tools/call`: a token that expired mid-session)
// Tools: `ping` (pong), `crash` (the process exits), `hang` (never
// answers), `rpcerr` (a JSON-RPC error of the server's own).
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const TOOLS = ["ping", "crash", "hang", "rpcerr"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }));

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } } };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const tool = params?.name;
    if (tool === "ping") return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "pong" }] } };
    if (tool === "crash") process.exit(3);
    if (tool === "hang") return null;
    if (tool === "rpcerr") return { jsonrpc: "2.0", id, error: { code: -32001, message: "upstream exploded" } };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result: {} };
}

export function startFakeMcp(mode) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if ((req.url ?? "").startsWith("/.well-known")) {
        res.writeHead(404);
        return res.end();
      }
      let message = {};
      try {
        message = JSON.parse(body);
      } catch {
        // A GET: no body.
      }
      if (mode === "401-all" || (mode === "expire-on-call" && message.method === "tools/call")) {
        res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"', "content-type": "application/json" });
        return res.end('{"error":"invalid_token"}');
      }
      if (req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      const answer = handle(message);
      if (!answer) {
        res.writeHead(202);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((done) => server.close(() => done())) })));
}

if (process.argv[2] === "stdio") {
  if (process.argv[3] === "boot-crash") {
    process.stderr.write("boom at boot\n");
    process.exit(1);
  }
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const answer = handle(message);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
}
