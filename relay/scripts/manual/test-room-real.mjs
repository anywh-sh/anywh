// A room against the REAL `claude` (Haiku): a test relay (its own port, data
// and env dir under a temp dir) and an agent host in this process (own socket
// and data). The principal is asked to delegate one task through the room's
// `delegate` tool; the worker must be born in the host, do it and `report`.
// Then the principal is asked which tools it has, to show its native `Agent`
// (and every writing tool) is really gone. Prints the evidence. Three or four
// short Haiku turns. Agents use the real $HOME (for the login) and a temp cwd.
// Run from relay/:
//   node --import tsx scripts/manual/test-room-real.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { AgentHost } from "../../src/agentHost/agentHost.ts";
import { findAgentProcesses } from "../../src/agentHost/processTree.ts";

const RELAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(join(tmpdir(), "anywh-room-real-"));
const cwd = join(dir, "work");
mkdirSync(cwd);
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const waitFor = async (check, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const freePort = () =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const hostId = `room-real-${process.pid}`;
const host = await AgentHost.start({ hostId, dataDir: join(dir, "host"), socketPath: join(dir, "run", "h.sock"), drainGraceMs: 3000 });
const port = await freePort();
const relayOutput = [];
const relay = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: RELAY_ROOT,
  env: {
    ...process.env,
    RELAY_PORT: String(port),
    RELAY_HOST: "127.0.0.1",
    RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
    RELAY_BACKGROUND_JOBS_FILE: join(dir, "bg.json"),
    RELAY_WAKEUPS_FILE: join(dir, "wakeups.json"),
    RELAY_PUSH_DISABLED: "1",
    ANYWH_ENV_DIR: join(dir, "env"),
    ANYWH_SESSIONS_ROOT: join(dir, "sessions-root"),
    ANYWH_AGENT_HOST_SOCKET: host.socketPath,
  },
});
relay.stdout.on("data", (chunk) => relayOutput.push(chunk.toString()));
relay.stderr.on("data", (chunk) => relayOutput.push(chunk.toString()));
const base = `http://127.0.0.1:${port}`;
const json = async (path, init) => (await fetch(`${base}${path}`, init)).json();

function turn(roomId, text) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?session=${roomId}`);
    const events = [];
    let started = false;
    const timer = setTimeout(() => fail(new Error("principal turn timed out")), 180_000);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "turn_state" && message.active) started = true;
      if (message.type === "agent_event") events.push(message.event);
      if ((message.type === "agent_event" && message.event.type === "turn_ended") || (started && message.type === "turn_state" && !message.active)) {
        clearTimeout(timer);
        socket.close();
        done(events);
      }
    });
    socket.on("open", () => socket.send(JSON.stringify({ type: "user_message", text })));
  });
}

let exitCode = 0;
try {
  await waitFor(async () => (await fetch(`${base}/agents/activity`).catch(() => undefined))?.status === 200, 30_000, "relay connected to the host");
  const { roomId } = await json("/rooms", { method: "POST", body: JSON.stringify({ agentId: "claude", model: "haiku", cwd, title: "real room check", permissionMode: "bypassPermissions" }) });
  log("room", roomId);

  const first = await turn(
    roomId,
    "Delegate exactly one task with the delegate tool: runtime claude, model haiku, task: " +
      "\"Reply with the single word PINEAPPLE, then call the report tool with status done and summary PINEAPPLE.\" " +
      "After delegating, end your turn with one short sentence.",
  );
  const calls = first.filter((event) => event.type === "tool_started").map((event) => event.name);
  const results = first.filter((event) => event.type === "tool_ended").map((event) => ({ isError: event.isError, content: String(event.content).slice(0, 200) }));
  log("principal turn 1 tool calls:", calls, "results:", results);
  const errors = first.filter((event) => event.type === "error");
  if (errors.length) log("principal turn 1 errors:", errors);
  const delegated = results.map((result) => /"agentId":"([^"]+)"/.exec(result.content)?.[1]).find(Boolean);
  if (!delegated) throw new Error("the principal did not delegate");

  let workerAgent;
  await waitFor(async () => {
    const room = await json(`/rooms/${roomId}`);
    workerAgent = room.members.find((member) => member.id === delegated);
    return workerAgent?.room.report !== undefined;
  }, 180_000, "the worker's report");
  const activity = (await json("/agents/activity")).agents;
  log("worker", delegated, "runtime", workerAgent.agentId, "model", workerAgent.model, "report", workerAgent.room.report);
  log("host agents:", activity.map((agent) => ({ agentId: agent.agentId.slice(0, 8), roomId: agent.roomId?.slice(0, 8), state: agent.state, pid: agent.pid })));
  const principal = (await json(`/rooms/${roomId}`)).members.find((member) => member.id === roomId);
  log("principal outbox (undeliveredReports):", principal.room.undeliveredReports);

  // The principal's own init event: which tools it really has.
  const logDir = join(dir, "host", "logs", roomId);
  const init = readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).ev))
    .find((event) => event.type === "system" && event.subtype === "init");
  const tools = init?.tools ?? [];
  log("principal tools (system/init):", tools);
  log("principal MCP servers:", init?.mcp_servers);
  const forbidden = ["Agent", "Task", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch"].filter((tool) => tools.includes(tool));
  log(forbidden.length === 0 ? "principal has none of Agent/Task/Bash/Write/Edit/NotebookEdit/WebFetch" : `principal STILL HAS: ${forbidden}`);
  if (forbidden.length > 0) exitCode = 1;

  const second = await turn(roomId, "Without calling any tool, list the exact names of the tools available to you, comma-separated, and say whether you have an Agent or Task tool.");
  log("principal turn 2 answer:", second.filter((event) => event.type === "text").map((event) => event.text).join(" ").slice(0, 600));
  const workerLogDir = join(dir, "host", "logs", delegated);
  const workerInit = readdirSync(workerLogDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(workerLogDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).ev))
    .find((event) => event.type === "system" && event.subtype === "init");
  // Claude Code 2.1.303 lists its native subagent tool as `Task` in `init`.
  const workerTools = workerInit?.tools ?? [];
  log("worker native subagent tool (Task/Agent):", workerTools.includes("Task") || workerTools.includes("Agent"), "worker has Bash:", workerTools.includes("Bash"), "worker room tools:", workerTools.filter((tool) => tool.startsWith("mcp__anywh-room")));
} catch (error) {
  exitCode = 1;
  console.error("FAILED:", error.message);
  console.error(relayOutput.join("").slice(-4000));
} finally {
  relay.kill("SIGTERM");
  await new Promise((done) => (relay.exitCode !== null ? done() : relay.once("exit", done)));
  await host.close({ drainGraceMs: 1000 });
  const left = await findAgentProcesses(hostId);
  log("processes of this host left:", left.length);
  rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}
