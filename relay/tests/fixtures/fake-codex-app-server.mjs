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
// Plan usage (`account/read`, `account/rateLimits/read` and the
// `account/rateLimits/updated` push) answers with the samples recorded in
// codex-app-server-0.154.0-rate-limits.json, for the account picked by
// FAKE_CODEX_ACCOUNT: `free` (default; measured), `plus` (a paid plan, NOT
// measured), `api_key` or `signed_out`. FAKE_CODEX_PUSH_AFTER_READ=1 pushes
// that account's `account/rateLimits/updated` right after each read (the
// empty `premium` bucket for `free`); FAKE_CODEX_RATE_LIMITS_HANG=1 never
// answers `account/rateLimits/read`. A turn whose text has [[rate-limits]]
// pushes the same update before it completes, like a real turn does.
// FAKE_CODEX_INIT_HANG=1 never answers `initialize` (the handshake that hung
// in a CODEX_HOME without a login); FAKE_CODEX_PID_FILE gets this process's
// pid, so a test can check it was stopped.
// MCP inventory: `codex mcp list --json` prints FAKE_CODEX_MCP_LIST_FILE
// (none: `[]`); the app-server's `mcpServerStatus/list` answers
// FAKE_CODEX_MCP_STATUS_FILE (a `ListMcpServerStatusResponse`; none: no
// servers), both read at each call so a test can change them between scans.
// FAKE_CODEX_MCP_PENDING_REPLIES=N reports every server `starting` in the
// first N replies; FAKE_CODEX_MCP_STATUS_HANG=1 never answers. A `threadId`
// this process did not start gets the real "thread not found" error; once
// FAKE_CODEX_FORGET_THREADS_FILE exists, the process forgets every thread
// (and removes the file), like an app-server that lost them.
// `mcpServer/tool/call` answers the official Atlassian server (by its URL in
// FAKE_CODEX_MCP_LIST_FILE or its `serverInfo` in FAKE_CODEX_MCP_STATUS_FILE)
// from fake-atlassian.mjs, a server the status file says has no login with
// the observed JSON-RPC error, and echoes any other call's server, tool and
// arguments as the text of a successful `CallToolResult`;
// `config/mcpServer/reload` answers `{}`.
// FAKE_CODEX_THREADS_DIR, if set, keeps each thread's completed turns there
// (one JSON file per thread, the `thread/turns/list` item shapes of 0.154.0)
// and answers `thread/turns/list` from it, so a relay restarted onto a new
// app-server replays the session; thread ids then differ between processes.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerAtlassianTool, isAtlassianServer } from "./fake-atlassian.mjs";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.154.0\n");
  process.exit(0);
}
if (process.env.FAKE_CODEX_PID_FILE) appendFileSync(process.env.FAKE_CODEX_PID_FILE, `${process.pid}\n`);
if (process.argv[2] === "mcp" && process.argv[3] === "list" && process.argv.includes("--json")) {
  const file = process.env.FAKE_CODEX_MCP_LIST_FILE;
  process.stdout.write(file && existsSync(file) ? readFileSync(file, "utf8") : "[]\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") {
  process.stderr.write(`fake codex: unsupported invocation ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
if (process.env.FAKE_CODEX_ENV_FILE) writeFileSync(process.env.FAKE_CODEX_ENV_FILE, JSON.stringify(process.env));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const { samples } = JSON.parse(readFileSync(join(import.meta.dirname, "codex-app-server-0.154.0-rate-limits.json"), "utf8"));
const account = process.env.FAKE_CODEX_ACCOUNT || "free";
const PLAN_USAGE = {
  free: { account: samples.accountReadChatgptFree, limits: samples.rateLimitsReadFree, update: samples.rateLimitsUpdatedEmpty },
  plus: { account: samples.accountReadChatgptPlus, limits: samples.rateLimitsReadPaid, update: samples.rateLimitsUpdatedPaid },
  api_key: { account: samples.accountReadApiKey, limits: samples.rateLimitsReadApiKeyError },
  signed_out: { account: samples.accountReadSignedOut, limits: samples.rateLimitsReadSignedOutError },
}[account];
if (!PLAN_USAGE) {
  process.stderr.write(`fake codex: unknown FAKE_CODEX_ACCOUNT ${account}\n`);
  process.exit(2);
}
const pushRateLimits = () => {
  if (PLAN_USAGE.update) send({ method: "account/rateLimits/updated", params: PLAN_USAGE.update.params });
};
let threads = 0;
let mcpStatusReplies = 0;
const readJson = (file, fallback) => (file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
/** The real app-server's answer to an unknown or missing `threadId`. */
function threadError(threadId) {
  const forget = process.env.FAKE_CODEX_FORGET_THREADS_FILE;
  if (forget && existsSync(forget)) {
    threadTools.clear();
    rmSync(forget);
  }
  if (threadId === null || threadId === undefined) return { code: -32600, message: "Invalid request: invalid type: null, expected a string" };
  return threadTools.has(threadId) ? undefined : { code: -32600, message: `thread not found: ${threadId}` };
}
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

const threadsDir = process.env.FAKE_CODEX_THREADS_DIR;
const threadFile = (threadId) => join(threadsDir, `${threadId}.json`);
function storeTurn(threadId, turnId, input, reply) {
  if (!threadsDir) return;
  const stored = readJson(threadFile(threadId), []);
  stored.push({
    id: turnId,
    status: "completed",
    startedAt: Math.floor(Date.now() / 1000),
    durationMs: 1,
    items: [
      { type: "userMessage", id: `user-${turnId}`, content: [{ type: "text", text: input, text_elements: [] }] },
      { type: "agentMessage", id: `item-${turnId}`, text: reply },
    ],
  });
  writeFileSync(threadFile(threadId), JSON.stringify(stored));
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
        if (process.env.FAKE_CODEX_INIT_HANG === "1") break;
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
        const threadId = threadsDir ? `thr-${process.pid}-${threads}` : `thr-${threads}`;
        threadTools.set(threadId, (message.params?.dynamicTools ?? []).map((tool) => tool.name));
        const answer = { id: message.id, result: { thread: { id: threadId }, model: "gpt-fake" } };
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
        if (text.includes("[[rate-limits]]")) pushRateLimits();
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
          // A moment after the `turn/start` answer, as a real turn ends: the
          // client learns the turn's id from that answer, and a completion
          // in the same read would reach it before it knows which turn ended.
          setTimeout(() => {
            complete(threadId, turnId, "completed", `echo: ${text}`);
            storeTurn(threadId, turnId, text, `echo: ${text}`);
          }, 20);
        }
        break;
      }
      case "thread/turns/list":
        if (threadsDir) send({ id: message.id, result: { data: readJson(threadFile(message.params?.threadId), []), nextCursor: null } });
        else send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
        break;
      case "account/read":
        send({ id: message.id, result: PLAN_USAGE.account.result });
        break;
      case "account/rateLimits/read":
        if (process.env.FAKE_CODEX_RATE_LIMITS_HANG === "1") break;
        if (PLAN_USAGE.limits.error) send({ id: message.id, error: PLAN_USAGE.limits.error });
        else send({ id: message.id, result: PLAN_USAGE.limits.result });
        if (process.env.FAKE_CODEX_PUSH_AFTER_READ === "1") pushRateLimits();
        break;
      case "mcpServerStatus/list": {
        if (process.env.FAKE_CODEX_MCP_STATUS_HANG === "1") break;
        const threadId = message.params?.threadId;
        const error = threadId === undefined ? undefined : threadError(threadId);
        if (error) {
          send({ id: message.id, error });
          break;
        }
        const status = readJson(process.env.FAKE_CODEX_MCP_STATUS_FILE, { data: [], nextCursor: null });
        const starting = mcpStatusReplies++ < Number(process.env.FAKE_CODEX_MCP_PENDING_REPLIES ?? 0);
        const data = starting ? status.data.map((server) => ({ ...server, runtimeStatus: "starting", tools: {}, toolsError: null, serverInfo: null })) : status.data;
        send({ id: message.id, result: { ...status, data } });
        break;
      }
      case "mcpServer/tool/call": {
        const { threadId, server, tool, arguments: args } = message.params ?? {};
        const error = threadError(threadId);
        if (error) {
          send({ id: message.id, error });
          break;
        }
        const declared = readJson(process.env.FAKE_CODEX_MCP_LIST_FILE, []).find((entry) => entry.name === server);
        const live = readJson(process.env.FAKE_CODEX_MCP_STATUS_FILE, { data: [] }).data.find((entry) => entry.name === server);
        if (live && (live.authStatus === "notLoggedIn" || live.runtimeStatus === "authenticationRequired")) {
          // Observed against the official server with no login.
          send({ id: message.id, error: { code: -32603, message: "failed to get client: MCP startup failed: handshaking with MCP server failed: Auth required, when send initialize request" } });
        } else if (isAtlassianServer(declared) || isAtlassianServer(live)) {
          send({ id: message.id, result: answerAtlassianTool("codex", server, tool, args) });
        } else {
          send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ server, tool, arguments: args ?? null }) }], isError: false } });
        }
        break;
      }
      case "config/mcpServer/reload":
        send({ id: message.id, result: {} });
        break;
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
