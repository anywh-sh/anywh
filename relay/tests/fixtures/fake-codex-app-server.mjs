#!/usr/bin/env node
// A fake `codex app-server` for the agent host's Codex skeleton: newline-
// delimited JSON-RPC over stdio, in the request/notification shapes the Codex
// def and its driver were checked against (codex-cli 0.154.0 generated
// bindings: `ThreadStartResponse`, `TurnStartResponse`, `turn/started`,
// `turn/completed`, `item/completed`, `item/commandExecution/requestApproval`).
// Not a model: what a turn does is scripted by markers in its input text.
//   (default)       one agentMessage item echoing the input, then completed
//   [[hang]]        turn stays in progress until `turn/interrupt`
//   [[slow-start]]  like [[hang]], but `turn/start` is answered 300 ms late
//   [[die]]         the whole app-server exits mid-turn
//   [[approval]]    asks for a command approval first; the answer is
//                   appended to FAKE_CODEX_RESPONSES (if set), then the turn
//                   completes
//   [[tool:<name>:<base64url JSON args>]] calls a dynamic tool the thread
//                   declared (`item/tool/call`, codex-cli 0.154.0 shapes:
//                   `DynamicToolCallParams`/`DynamicToolCallResponse`), with
//                   its `dynamicToolCall` item started/completed around it;
//                   repeatable, in order; the turn then says the last
//                   answer. A tool the thread did not declare is answered as
//                   the real app-server would refuse it, without a request.
// `--version` prints the version these shapes were recorded from.
// FAKE_CODEX_ENV_FILE, if set, gets this process's environment as JSON.
// FAKE_CODEX_REQUESTS, if set, gets every request from the client appended
// as one JSON line. FAKE_CODEX_NO_DYNAMIC_TOOLS=1 (or a thread whose cwd
// contains "without-dynamic-tools") makes `thread/start` refuse
// `dynamicTools` the way a Codex without the experimental API would; a cwd
// containing "thread-start-fails" makes it refuse any thread (not logged in),
// one containing "slow-thread" answers `thread/start` 400 ms late.
import { appendFileSync, writeFileSync } from "node:fs";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.154.0\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") {
  process.stderr.write(`fake codex: unsupported invocation ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
if (process.env.FAKE_CODEX_ENV_FILE) writeFileSync(process.env.FAKE_CODEX_ENV_FILE, JSON.stringify(process.env));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let threads = 0;
let turns = 0;
const hanging = new Map(); // turnId -> threadId
const awaitingApproval = new Map(); // server request id -> { threadId, turnId }
const threadTools = new Map(); // threadId -> declared dynamic tool names
const awaitingTool = new Map(); // server request id -> { threadId, turnId, itemId, item, resolve }

function callTool(threadId, turnId, index, name, args) {
  return new Promise((resolve) => {
    const itemId = `dyn-${turnId}-${index}`;
    const item = { type: "dynamicToolCall", id: itemId, namespace: null, tool: name, arguments: args, status: "inProgress", contentItems: null, success: null, durationMs: null };
    send({ method: "item/started", params: { threadId, turnId, item } });
    if (!(threadTools.get(threadId) ?? []).includes(name)) {
      const text = `unknown tool ${name}`;
      send({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "failed", contentItems: [{ type: "inputText", text }], success: false } } });
      resolve(text);
      return;
    }
    const id = `tool-${turnId}-${index}`;
    awaitingTool.set(id, { threadId, turnId, item, resolve });
    send({ id, method: "item/tool/call", params: { threadId, turnId, callId: itemId, namespace: null, tool: name, arguments: args } });
  });
}

async function runToolTurn(threadId, turnId, calls) {
  let last = "";
  for (const [index, [, name, encoded]] of calls.entries()) {
    last = await callTool(threadId, turnId, index, name, encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) : {});
  }
  complete(threadId, turnId, "completed", `tool: ${last}`);
}

function complete(threadId, turnId, status, text) {
  if (text !== undefined) {
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: `item-${turnId}`, text } } });
  }
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, error: null, items: [] } } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (process.env.FAKE_CODEX_REQUESTS && message.method !== undefined) appendFileSync(process.env.FAKE_CODEX_REQUESTS, `${JSON.stringify(message)}\n`);
    if (message.method === undefined && message.id !== undefined && awaitingTool.has(message.id)) {
      const pending = awaitingTool.get(message.id);
      awaitingTool.delete(message.id);
      const result = message.result ?? { contentItems: [{ type: "inputText", text: JSON.stringify(message.error) }], success: false };
      const text = (result.contentItems ?? []).map((part) => part.text ?? "").join("");
      send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId, item: { ...pending.item, status: result.success ? "completed" : "failed", contentItems: result.contentItems, success: result.success } } });
      pending.resolve(text);
      continue;
    }
    if (message.method === undefined && message.id !== undefined) {
      // The host's answer to one of our requests.
      const pending = awaitingApproval.get(message.id);
      if (!pending) continue;
      awaitingApproval.delete(message.id);
      if (process.env.FAKE_CODEX_RESPONSES) appendFileSync(process.env.FAKE_CODEX_RESPONSES, `${JSON.stringify(message.result ?? message.error)}\n`);
      complete(pending.threadId, pending.turnId, "completed", "did not run it");
      continue;
    }
    switch (message.method) {
      case "initialize":
        send({ id: message.id, result: { userAgent: "fake-codex/0.154.0" } });
        break;
      case "thread/start": {
        if (/thread-start-fails/.test(message.params?.cwd ?? "")) {
          send({ id: message.id, error: { code: -32603, message: "not logged in" } });
          break;
        }
        if (message.params?.dynamicTools && (process.env.FAKE_CODEX_NO_DYNAMIC_TOOLS === "1" || /without-dynamic-tools/.test(message.params.cwd ?? ""))) {
          send({ id: message.id, error: { code: -32602, message: "Invalid params: unknown field `dynamicTools`" } });
          break;
        }
        threads++;
        threadTools.set(`thr-${threads}`, (message.params?.dynamicTools ?? []).map((tool) => tool.name));
        const answer = { id: message.id, result: { thread: { id: `thr-${threads}` }, model: "gpt-fake" } };
        // A thread that takes a while to start (a cold app-server).
        if (/slow-thread/.test(message.params?.cwd ?? "")) setTimeout(() => send(answer), 400);
        else send(answer);
        break;
      }
      case "thread/resume": {
        const { threadId } = message.params;
        // Dynamic tools survive a resume in the real app-server; this fake
        // keeps them per process only, so a resumed thread declares none.
        if (!threadTools.has(threadId)) threadTools.set(threadId, []);
        send({ id: message.id, result: { thread: { id: threadId }, model: "gpt-fake" } });
        break;
      }
      case "turn/start": {
        turns++;
        const turnId = `turn-${turns}`;
        const { threadId } = message.params;
        const text = (message.params.input ?? []).map((part) => part.text ?? "").join("");
        if (text.includes("[[slow-start]]")) {
          // The turn runs, but its id reaches the client only later: a Stop
          // sent meanwhile has no turn id to name yet.
          hanging.set(turnId, threadId);
          setTimeout(() => {
            send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
            send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
          }, 300);
          break;
        }
        send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
        send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
        if (text.includes("[[die]]")) {
          // After what was already written reaches the pipe.
          process.stdout.write("", () => process.exit(1));
        } else if (text.includes("[[hang]]")) {
          hanging.set(turnId, threadId);
        } else if (/\[\[tool:/.test(text)) {
          void runToolTurn(threadId, turnId, [...text.matchAll(/\[\[tool:([a-z_]+):([A-Za-z0-9_-]*)\]\]/g)]);
        } else if (text.includes("[[approval]]")) {
          const id = `srv-${turns}`;
          awaitingApproval.set(id, { threadId, turnId });
          send({ id, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: `cmd-${turns}`, command: "rm -rf build", reason: "outside the sandbox" } });
        } else {
          complete(threadId, turnId, "completed", `echo: ${text}`);
        }
        break;
      }
      case "turn/interrupt": {
        const { threadId, turnId } = message.params;
        send({ id: message.id, result: {} });
        if (hanging.delete(turnId)) complete(threadId, turnId, "interrupted");
        break;
      }
      default:
        send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
