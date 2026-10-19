// Regression check for long tool approvals on the REAL `claude` binary: a
// permission prompt left unanswered for ~2 minutes must still be answerable,
// and the approved tool must then actually run. The relay passes a very
// long per-server `timeout` for the `anywh-permission` MCP server in --mcp-config; without
// it the CLI cuts a pending MCP call at 60 s and the call degrades to a
// denial. Measured with CLI 2.1.303: with the field, a 120 s wait survives;
// this script covers 120 s, not longer waits. CI cannot cover this (it needs a real model and a 2 min wait);
// relay/src/runtimes/defs/claude/mcpSpawnConfig.test.ts guards that the
// field is present in the generated config, this script proves it works.
//
// Self-contained: builds nothing, so run `npm run build` first, then from
// `relay/`: `node scripts/manual/test-long-approval.mjs`. It starts its own
// relay on a free port with throwaway data under a temp dir (never touches
// the real profiles), uses Haiku and one trivial Write, and kills only the
// process group of the relay it started. Costs a couple of Haiku turns.
//
// Isolation: RELAY_HOME_OVERRIDE points the relay and the `claude` child at a
// temp HOME, so settings, projects and transcripts of the real ~/.claude are
// never read or written. The one thing read from the real HOME is the login:
// ~/.claude/.credentials.json is copied into the temp HOME (removed at the
// end). The CLI may refresh that copy's token; the real file is not touched,
// but if the CLI rotates the refresh token in the copy, the real file keeps
// the old one and may need a fresh `claude` login afterwards. Logins kept in
// the macOS Keychain (no credentials file) are not supported: the script
// exits with a clear message. The relay env is an allowlist (PATH, the temp
// HOME and the RELAY_*/ANYWH_* vars set below), not the caller's env.
//
//   WAIT_MS=120000  how long to leave the approval pending (default 2 min)
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const WAIT_MS = Number(process.env.WAIT_MS ?? 120_000);
if (!Number.isInteger(WAIT_MS) || WAIT_MS <= 0) {
  console.error(`invalid WAIT_MS=${JSON.stringify(process.env.WAIT_MS)}: expected a positive integer (milliseconds)`);
  process.exit(2);
}
const realCreds = join(homedir(), ".claude", ".credentials.json");
if (!existsSync(realCreds)) {
  console.error(`${realCreds} not found (Keychain-based login?): this script needs the credentials file`);
  process.exit(2);
}
const relayRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(`[${ts()}]`, ...args);

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitFor(predicate, timeoutMs, label, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const dir = mkdtempSync(join(tmpdir(), "anywh-long-approval-"));
const fakeHome = join(dir, "home");
mkdirSync(join(fakeHome, ".claude"), { recursive: true });
copyFileSync(realCreds, join(fakeHome, ".claude", ".credentials.json"));
chmodSync(join(fakeHome, ".claude", ".credentials.json"), 0o600);
const port = await freePort();
const target = join(dir, "approved.txt");
const marker = `long-approval-${Date.now()}`;

log(`relay on 127.0.0.1:${port}, data in ${dir}`);
const relay = spawn(process.execPath, ["dist/server.js"], {
  cwd: relayRoot,
  env: {
    PATH: process.env.PATH,
    HOME: fakeHome,
    RELAY_PORT: String(port),
    RELAY_HOST: "127.0.0.1",
    RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
    RELAY_BACKGROUND_JOBS_FILE: join(dir, "background-jobs.json"),
    RELAY_WAKEUPS_FILE: join(dir, "wakeups.json"),
    RELAY_PUSH_DEVICES_FILE: join(dir, "push-devices.json"),
    RELAY_PUSH_DISABLED: "1",
    RELAY_HOME_OVERRIDE: fakeHome,
    // The turn is blocked on the pending approval at cleanup time; do not let
    // the graceful shutdown wait the default 4 minutes for it.
    RELAY_SHUTDOWN_GRACE_MS: "1000",
    RELAY_UPLOAD_DIR: join(dir, "uploads"),
    ANYWH_ENV_DIR: join(dir, "env"),
    ANYWH_THEMES_DIR: join(dir, "themes"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  // Own process group, so cleanup can SIGKILL the relay and the `claude`
  // children it spawned by group id (a PID this script started), never by name.
  detached: true,
});
const killGroup = (signal) => {
  try {
    process.kill(-relay.pid, signal);
  } catch {
    // group already gone
  }
};
let relayLog = "";
relay.stdout.on("data", (chunk) => (relayLog += chunk));
relay.stderr.on("data", (chunk) => (relayLog += chunk));

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  socket?.close();
  if (relay.exitCode === null) {
    relay.kill("SIGTERM");
    const exited = new Promise((resolve) => relay.once("exit", () => resolve(true)));
    const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), 5_000));
    if (!(await Promise.race([exited, timedOut]))) {
      console.error(`[${ts()}] relay ignored SIGTERM for 5s, sending SIGKILL to its process group`);
      killGroup("SIGKILL");
      await new Promise((resolve) => relay.once("exit", resolve));
    }
  }
  // Stragglers (the claude child) of the group we started.
  killGroup("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[${ts()}] ${sig}: cleaning up`);
    cleanup().finally(() => process.exit(130));
  });
}

let exitCode = 1;
let socket;
try {
  await waitFor(() => relayLog.includes("[relay] listening on") || relay.exitCode !== null, 15_000, "relay boot");
  if (relay.exitCode !== null) throw new Error(`relay exited early:\n${relayLog}`);

  const events = [];
  let prompt;
  let resolved = false;
  let reAsked = false;
  let extraApproval;
  const promptKey = (m) => JSON.stringify(m.questions);
  let turnEnded = 0;
  socket = new WebSocket(`ws://127.0.0.1:${port}/?session=long-approval-${Date.now()}`);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "choice_prompt") {
      // The SAME request again means the CLI cut the first pending call (at
      // 60 s without `timeout`) and retried it; a different one is simply
      // unexpected for this script.
      if (prompt) {
        if (promptKey(message) === promptKey(prompt)) reAsked = true;
        else extraApproval = promptKey(message);
      }
      prompt = prompt ?? message;
      log("choice_prompt:", JSON.stringify(message.questions[0]?.question));
    } else if (message.type === "choice_resolved") {
      resolved = true;
    } else if (message.type === "agent_event") {
      events.push(message.event);
      if (message.event.type === "turn_ended") {
        turnEnded += 1;
        log(`turn_ended #${turnEnded}`);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({ type: "set_model", model: "haiku" }));
  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "default" }));
  await new Promise((resolve) => setTimeout(resolve, 500));

  log("asking for a Write that needs approval");
  socket.send(
    JSON.stringify({
      type: "user_message",
      text: `Use the Write tool to create the file ${target} with exactly this content: ${marker}. Do nothing else and reply "done" afterwards.`,
    }),
  );

  await waitFor(() => prompt || turnEnded > 0, 90_000, "approval prompt");
  if (!prompt) throw new Error("turn ended without ever asking for approval (model did not call Write, or mode auto-allowed it)");
  const promptAt = Date.now();

  // Poll with timestamps instead of one blind sleep: any early end of the
  // turn (the CLI cutting the pending call and auto-denying) is caught at
  // the moment it happens and reported with its elapsed time.
  let nextTick = 15_000;
  while (Date.now() - promptAt < WAIT_MS) {
    const elapsed = Date.now() - promptAt;
    if (turnEnded > 0 || resolved) {
      throw new Error(`FAIL: approval was cut after ${(elapsed / 1000).toFixed(1)}s (turn ended / prompt resolved before anyone answered)`);
    }
    if (extraApproval) throw new Error(`FAIL: unexpected extra approval prompt while waiting: ${extraApproval.slice(0, 300)}`);
    if (reAsked) {
      throw new Error(`FAIL: the CLI cut the pending approval and asked again after ${(elapsed / 1000).toFixed(1)}s`);
    }
    if (elapsed >= nextTick) {
      log(`still pending after ${(elapsed / 1000).toFixed(0)}s of ${(WAIT_MS / 1000).toFixed(0)}s`);
      nextTick += 15_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (extraApproval) throw new Error(`FAIL: unexpected extra approval prompt: ${extraApproval.slice(0, 300)}`);
  if (reAsked) throw new Error("FAIL: the CLI cut the pending approval and asked again");
  if (turnEnded > 0 || resolved) throw new Error("FAIL: approval resolved on its own before the answer");

  if (Date.now() - promptAt < WAIT_MS) throw new Error("FAIL: internal: approving before WAIT_MS elapsed");
  log(`answering approve after ${((Date.now() - promptAt) / 1000).toFixed(1)}s`);
  const question = prompt.questions[0];
  socket.send(
    JSON.stringify({
      type: "choice_answer",
      promptId: prompt.promptId,
      answers: [{ question: question.question, selected: ["approve"] }],
    }),
  );

  await waitFor(() => turnEnded > 0 || reAsked || extraApproval, 90_000, "turn_ended after approval");
  if (extraApproval) throw new Error(`FAIL: unexpected extra approval prompt after the answer: ${extraApproval.slice(0, 300)}`);
  if (reAsked) throw new Error("FAIL: the CLI asked for approval again after the answer was sent (answer not accepted)");
  if (!resolved) throw new Error("FAIL: no choice_resolved after the answer (approval was not accepted)");
  const content = existsSync(target) ? readFileSync(target, "utf8").trim() : undefined;
  log("file content:", JSON.stringify(content));
  if (content !== marker) {
    const toolResults = events.filter((e) => e.type === "tool_result" || e.type === "error");
    throw new Error(`FAIL: tool did not execute after the late approval. events: ${JSON.stringify(toolResults).slice(0, 800)}`);
  }
  log(`PASS: approval survived ${(WAIT_MS / 1000).toFixed(0)}s pending, answer accepted, Write executed`);
  exitCode = 0;
} catch (error) {
  console.error(`[${ts()}] ${error.message}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
