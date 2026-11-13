#!/usr/bin/env node
// A fake Agent Client Protocol agent (`<agent> acp`): newline-delimited
// JSON-RPC over stdio, in the shapes recorded from Kimi Code CLI 2.6.0's
// `kimi acp` (initialize, session/new|resume|load|delete|prompt|set_mode|
// set_config_option, session/cancel, session/update, session/request_permission).
// Not a model: what a turn does is scripted by markers in its prompt text.
//   (default)    a thought, then the reply "echo: <prompt>" in two chunks
//   [[tool]]     a Bash call: announced, input streamed, then a permission
//                request without the input (as Kimi sends it); allowed →
//                completed with "file.txt\n", rejected → failed
//   [[hang]]     a permission request that stays open: the turn ends only
//                after `session/cancel` AND that request was answered
//                `cancelled` (ACP's rule), with stopReason "cancelled"
//   [[question]] an AskUserQuestion call asking "Pick one" (Red/Blue) through
//                session/request_permission, as Kimi does; the reply names
//                the answer
//   [[fail]]     session/prompt answers the subscription error Kimi gives a
//                model the plan doesn't include
// Every prompt starts with a usage_update (used = 100 × prompts so far).
// Sessions live in FAKE_ACP_STATE (a JSON file) so a fresh process can
// resume or load one; FAKE_ACP_LOG gets every message received, one JSON
// line each. `--version` prints the version the shapes were recorded from.
// FAKE_ACP_IDLE_EXIT_MS, if set, makes the process exit after that long with
// no turn running — so a test relay that never disposes its sessions doesn't
// keep its own process alive on these children; the next turn then runs on
// a fresh process, as after the relay's own idle reaper.
import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("2.6.0");
  process.exit(0);
}

const STATE = process.env.FAKE_ACP_STATE;
const LOG = process.env.FAKE_ACP_LOG;

function loadSessions() {
  if (!STATE || !fs.existsSync(STATE)) return {};
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
function saveSessions(sessions) {
  if (STATE) fs.writeFileSync(STATE, JSON.stringify(sessions));
}

const MODELS = [
  { value: "m1", name: "Model One" },
  { value: "m2", name: "Model Two" },
];
const THINKING = { m1: ["low", "high", "max"], m2: ["on", "high"] };

function configOptions(session) {
  return [
    { type: "select", id: "model", name: "Model", category: "model", currentValue: session.model, options: MODELS },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: session.thinking,
      options: THINKING[session.model].map((value) => ({ value, name: `Thinking ${value}` })),
    },
    { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: session.mode, options: [{ value: "default" }, { value: "yolo" }] },
  ];
}

let nextId = 1000;
const pendingClient = new Map();
let attached = new Set();
let cancelled = new Set();
let prompts = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function update(sessionId, payload) {
  send({ method: "session/update", params: { sessionId, update: payload } });
}
function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pendingClient.set(id, resolve));
}
function error(id, message) {
  send({ id, error: { code: -32602, message } });
}

function known(sessionId) {
  return loadSessions()[sessionId];
}

async function runPrompt(id, params) {
  const sessions = loadSessions();
  const session = sessions[params.sessionId];
  if (!session || !attached.has(params.sessionId)) return error(id, `Invalid params: Unknown sessionId: ${params.sessionId}`);
  const text = params.prompt.map((block) => block.text ?? "").join("");
  prompts += 1;
  update(params.sessionId, { sessionUpdate: "usage_update", used: 100 * prompts, size: 1000 });
  session.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  session.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "<system-reminder>\nToday's date is 2026-11-12.\n</system-reminder>" } });
  const say = (reply) => {
    for (const piece of [reply.slice(0, 3), reply.slice(3)]) update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
    session.history.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  };

  if (text.includes("[[fail]]")) {
    send({ id, error: { code: -32000, message: "Authentication required: Your current subscription does not have access to m2. Upgrade to higher-tier plans." } });
    return;
  }

  if (text.includes("[[tool]]")) {
    const call = "0:tool_bash";
    update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: call, title: "Bash", kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "" } }] });
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "in_progress", content: [{ type: "content", content: { type: "text", text: '{"command":' } }] });
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, title: "Running: ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } });
    const answer = await ask("session/request_permission", {
      sessionId: params.sessionId,
      options: [
        { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
        { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      toolCall: { toolCallId: call, title: "Bash", content: [{ type: "content", content: { type: "text", text: "Requesting approval to Running: ls" } }] },
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId.startsWith("approve");
    const done = allowed
      ? { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed", rawOutput: "file.txt\n", content: [{ type: "content", content: { type: "text", text: "file.txt\n" } }] }
      : { sessionUpdate: "tool_call_update", toolCallId: call, status: "failed", rawOutput: 'Tool "Bash" was not run because the user rejected the approval request.' };
    update(params.sessionId, done);
    session.history.push({ sessionUpdate: "tool_call", toolCallId: call, title: "Bash", kind: "execute", status: "in_progress", rawInput: { command: "ls" } }, done);
    say(allowed ? "listed" : "refused");
  } else if (text.includes("[[hang]]")) {
    const answer = await ask("session/request_permission", {
      sessionId: params.sessionId,
      options: [{ optionId: "approve_once", name: "Approve once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      toolCall: { toolCallId: "0:tool_hang", title: "Bash", content: [] },
    });
    if (answer?.outcome?.outcome === "cancelled" && cancelled.has(params.sessionId)) {
      cancelled.delete(params.sessionId);
      saveSessions(sessions);
      send({ id, result: { stopReason: "cancelled" } });
      return;
    }
    say("not cancelled");
  } else if (text.includes("[[question]]")) {
    const call = "0:tool_question";
    update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: call, title: "AskUserQuestion", kind: "other", status: "pending" });
    const rawInput = { questions: [{ question: "Pick one", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }] };
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, title: "Asking user questions", kind: "other", status: "in_progress", rawInput });
    const answer = await ask("session/request_permission", {
      sessionId: params.sessionId,
      options: [
        { optionId: "q0_opt_0", name: "Red", kind: "allow_once" },
        { optionId: "q0_opt_1", name: "Blue", kind: "allow_once" },
        { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
      ],
      toolCall: { toolCallId: call, title: "AskUserQuestion", content: [{ type: "content", content: { type: "text", text: "Pick one" } }] },
    });
    const picked = answer?.outcome?.optionId;
    const label = picked === "q0_opt_0" ? "Red" : picked === "q0_opt_1" ? "Blue" : undefined;
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed", rawOutput: JSON.stringify({ answers: label ? { "Pick one": label } : {} }) });
    say(`answer: ${label ?? "skipped"}`);
  } else {
    update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over" } });
    say(`echo: ${text}`);
  }
  saveSessions(sessions);
  send({ id, result: { stopReason: "end_turn" } });
}

const IDLE_EXIT_MS = Number(process.env.FAKE_ACP_IDLE_EXIT_MS ?? 0);
let running = 0;
let idleTimer;
function armIdleExit() {
  if (!IDLE_EXIT_MS) return;
  clearTimeout(idleTimer);
  if (running === 0 && pendingClient.size === 0) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
}
armIdleExit();

function handle(message) {
  clearTimeout(idleTimer);
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(message)}\n`);
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingClient.get(message.id);
    pendingClient.delete(message.id);
    resolve?.(message.result);
    armIdleExit();
    return;
  }
  const { id, method, params } = message;
  queueMicrotask(armIdleExit);
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, delete: {} } }, agentInfo: { name: "Fake ACP", version: "2.6.0" } } });
      return;
    case "session/new": {
      const sessions = loadSessions();
      const sessionId = `session_${Object.keys(sessions).length + 1}`;
      sessions[sessionId] = { model: "m1", thinking: "high", mode: "default", history: [] };
      saveSessions(sessions);
      attached.add(sessionId);
      send({ id, result: { sessionId, configOptions: configOptions(sessions[sessionId]) } });
      return;
    }
    case "session/resume": {
      const session = known(params.sessionId);
      if (!session) return error(id, `Invalid params: Unknown sessionId: ${params.sessionId}`);
      attached.add(params.sessionId);
      send({ id, result: { configOptions: configOptions(session) } });
      return;
    }
    case "session/load": {
      const session = known(params.sessionId);
      if (!session) return error(id, `Invalid params: Unknown sessionId: ${params.sessionId}`);
      for (const entry of session.history) update(params.sessionId, entry);
      attached.add(params.sessionId);
      send({ id, result: { configOptions: configOptions(session) } });
      return;
    }
    case "session/delete": {
      const sessions = loadSessions();
      delete sessions[params.sessionId];
      saveSessions(sessions);
      send({ id, result: {} });
      return;
    }
    case "session/set_mode":
    case "session/set_config_option": {
      const sessions = loadSessions();
      const session = sessions[params.sessionId];
      if (!session) return error(id, `Invalid params: Unknown sessionId: ${params.sessionId}`);
      if (method === "session/set_mode") session.mode = params.modeId;
      else if (params.configId === "model") session.model = params.value;
      else if (params.configId === "thinking") {
        if (!THINKING[session.model].includes(params.value)) return error(id, `Invalid params: Unknown thinking value: ${params.value}`);
        session.thinking = params.value;
      }
      saveSessions(sessions);
      send({ id, result: { configOptions: configOptions(session) } });
      return;
    }
    case "session/prompt":
      running += 1;
      void runPrompt(id, params).finally(() => {
        running -= 1;
        armIdleExit();
      });
      return;
    case "session/cancel":
      cancelled.add(params.sessionId);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (err) {
    process.stderr.write(`fake-acp-agent: ${err}\n`);
  }
});
rl.on("close", () => process.exit(0));
