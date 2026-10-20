// Drives the agent host against the REAL `claude` binary (Haiku, four short
// turns) and prints what happened: one turn, an interrupt with a foreground
// command in flight (the process must survive it), hibernate + resume with
// --resume (does the session remember?), and a graceful stop with a
// background command running (does anything survive?).
//
// The host runs in this process with its own socket and data under a temp
// dir; agents use the real $HOME (for the login) and a temp cwd. Costs real
// model turns. Run from relay/:
//   node --import tsx scripts/manual/test-agent-host-real.mjs
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../../src/agentHost/agentHost.ts";
import { HostClient, START_OF_LOG } from "../../src/agentHost/hostClient.ts";
import { findAgentProcesses, isAlive } from "../../src/agentHost/processTree.ts";

const dir = mkdtempSync(join(tmpdir(), "anywh-host-real-"));
const cwd = join(dir, "work");
mkdirSync(cwd);
const hostId = `manual-${process.pid}`;
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const t0 = Date.now();

const host = await AgentHost.start({ hostId, dataDir: join(dir, "data"), socketPath: join(dir, "run", "h.sock"), drainGraceMs: 5000 });
const client = new HostClient({ socketPath: host.socketPath });
client.start();
await client.waitUntilConnected();

const events = [];
const waitFor = async (check, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const results = () => events.filter((e) => e.ev.type === "result");
const activity = async () => (await client.request("activity")).agents.find((a) => a.agentId === "real1");
const lastResult = () => {
  const r = results().at(-1).ev;
  return { is_error: r.is_error, subtype: r.subtype, terminal_reason: r.terminal_reason, result: String(r.result ?? "").slice(0, 120) };
};

try {
  // 1. spawn + one turn
  const spawned = await client.request("spawn", {
    agentId: "real1",
    spec: { cwd, model: "haiku", permissionMode: "bypassPermissions" },
    message: "Reply with exactly: PONG-1",
  });
  client.subscribe("real1", START_OF_LOG, { onEvent: (e) => events.push(e) });
  const pid = spawned.pid;
  await waitFor(() => results().length === 1, 90_000, "turn 1");
  const init = events.find((e) => e.ev.type === "system" && e.ev.subtype === "init");
  log("turn 1:", lastResult(), "pid", pid, "session", init?.ev.session_id, "first init after spawn ms", init.t - events[0].t, "result after spawn ms", results()[0].t - events[0].t);

  // 2. interrupt with a foreground command in flight
  await client.request("send", { agentId: "real1", message: "Use the Bash tool to run exactly `sleep 120` in the foreground (not in background). After it finishes, reply DONE." });
  await waitFor(() => events.some((e) => e.ev.type === "assistant" && JSON.stringify(e.ev).includes("sleep 120")), 60_000, "Bash tool call");
  const procsDuring = await findAgentProcesses(hostId, "real1");
  const interruptAt = Date.now();
  log("interrupt:", await client.request("interrupt", { agentId: "real1" }), "agent processes before:", procsDuring.length);
  await waitFor(() => results().length === 2, 30_000, "interrupted result");
  const afterInterrupt = await activity();
  const procsAfter = await findAgentProcesses(hostId, "real1");
  log("turn 2 (interrupted):", lastResult(), `result ${Date.now() - interruptAt}ms after interrupt;`, "state", afterInterrupt.state, "same pid", afterInterrupt.pid === pid, "agent processes after:", procsAfter.length);

  // 3. hibernate, then resume
  const sessionId = (await activity()).sessionId;
  const hib = await client.request("hibernate", { agentId: "real1" });
  log("hibernated:", hib.state, "alive", hib.alive, "old pid alive", isAlive(pid));
  const sendAt = Date.now();
  const sent = await client.request("send", { agentId: "real1", message: "What exact text did you reply in your very first answer in this conversation? Reply with just that text." });
  const resumedFrom = events.length;
  await waitFor(() => results().length === 3, 60_000, "turn 3");
  const resumedInit = events.slice(resumedFrom).find((e) => e.ev.type === "system" && e.ev.subtype === "init");
  const after = await activity();
  log("turn 3 (resumed):", sent, lastResult(), "same session", after.sessionId === sessionId, "new pid", after.pid, `init ${resumedInit ? resumedInit.t - sendAt : "?"}ms, result ${results().at(-1).t - sendAt}ms after send`);

  // 4. background command, then graceful stop
  await client.request("send", { agentId: "real1", message: "Use the Bash tool with run_in_background set to true to run exactly `sleep 200`. Then reply STARTED without waiting for it." });
  await waitFor(() => results().length === 4, 60_000, "turn 4");
  const beforeStop = await activity();
  log("before stop: state", beforeStop.state, "background tasks", beforeStop.backgroundTasks);
  const bgProcs = await findAgentProcesses(hostId, "real1");
  const stopAt = Date.now();
  const stopped = await client.request("stop", { agentId: "real1" });
  const leftover = (await findAgentProcesses(hostId, "real1")).filter(isAlive);
  log("turn 4:", lastResult(), "agent processes before stop:", bgProcs.length, `stop took ${Date.now() - stopAt}ms;`, "state", stopped.state, "left alive:", leftover.length, "background tasks seen", (await activity()).backgroundTasks);
  const exits = events.filter((e) => e.ev.type === "host_process").map((e) => `${e.ev.subtype}${e.ev.subtype === "exited" ? `(code ${e.ev.code}, signal ${e.ev.signal})` : ""}`);
  log("host process events:", exits.join(", "));
  const costs = results().map((e) => e.ev.total_cost_usd ?? 0);
  log("turns:", results().length, "total_cost_usd", costs.reduce((a, b) => a + b, 0).toFixed(4));
} finally {
  client.close();
  await host.close({ drainGraceMs: 1000 });
  log("host closed; data in", dir);
}
