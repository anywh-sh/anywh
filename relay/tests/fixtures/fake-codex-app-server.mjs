#!/usr/bin/env node
// A fake `codex app-server` for the agent host's Codex skeleton: newline-
// delimited JSON-RPC over stdio, in the request/notification shapes the Codex
// def and its driver were checked against (codex-cli 0.154.0 generated
// bindings: `ThreadStartResponse`, `TurnStartResponse`, `turn/started`,
// `turn/completed`, `item/completed`, `item/commandExecution/requestApproval`).
// Not a model: what a turn does is scripted by markers in its input text.
//   (default)       one agentMessage item echoing the input, then completed
//   [[hang]]        turn stays in progress until `turn/interrupt`
//   [[die]]         the whole app-server exits mid-turn
//   [[approval]]    asks for a command approval first; the answer is
//                   appended to FAKE_CODEX_RESPONSES (if set), then the turn
//                   completes
// FAKE_CODEX_ENV_FILE, if set, gets this process's environment as JSON.
import { appendFileSync, writeFileSync } from "node:fs";

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
      case "thread/start":
        threads++;
        send({ id: message.id, result: { thread: { id: `thr-${threads}` }, model: "gpt-fake" } });
        break;
      case "turn/start": {
        turns++;
        const turnId = `turn-${turns}`;
        const { threadId } = message.params;
        const text = (message.params.input ?? []).map((part) => part.text ?? "").join("");
        send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
        send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", error: null, items: [] } } });
        if (text.includes("[[die]]")) {
          // After what was already written reaches the pipe.
          process.stdout.write("", () => process.exit(1));
        } else if (text.includes("[[hang]]")) {
          hanging.set(turnId, threadId);
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
