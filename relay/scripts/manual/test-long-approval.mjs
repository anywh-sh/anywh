// Regression check for long tool approvals on the REAL `claude` binary: a
// permission prompt left unanswered for ~2 minutes must still be answerable,
// and the approved tool must then actually run. The relay passes `timeout:
// 86400000` for the `anywh-permission` MCP server in --mcp-config; without
// it the CLI cuts a pending MCP call at 60 s and the call degrades to a
// denial. CI cannot cover this (it needs a real model and a 2 min wait);
// relay/src/runtimes/defs/claude/mcpSpawnConfig.test.ts guards that the
// field is present in the generated config, this script proves it works.
//
// Self-contained: builds nothing, so run `npm run build` first, then from
// `relay/`: `node scripts/manual/test-long-approval.mjs`. It starts its own
// relay on a free port with throwaway data under a temp dir (never touches
// the real profiles), uses Haiku and one trivial Write, and kills only the
// relay process it started. Costs a couple of Haiku turns.
//
//   WAIT_MS=120000  how long to leave the approval pending (default 2 min)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const WAIT_MS = Number(process.env.WAIT_MS ?? 120_000);
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
const port = await freePort();
const target = join(dir, "approved.txt");
const marker = `long-approval-${Date.now()}`;

log(`relay on 127.0.0.1:${port}, data in ${dir}`);
const relay = spawn(process.execPath, ["dist/server.js"], {
  cwd: relayRoot,
  env: {
    ...process.env,
    RELAY_PORT: String(port),
    RELAY_HOST: "127.0.0.1",
    RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
    RELAY_BACKGROUND_JOBS_FILE: join(dir, "background-jobs.json"),
    RELAY_WAKEUPS_FILE: join(dir, "wakeups.json"),
    RELAY_PUSH_DEVICES_FILE: join(dir, "push-devices.json"),
    RELAY_PUSH_DISABLED: "1",
    RELAY_UPLOAD_DIR: join(dir, "uploads"),
    ANYWH_ENV_DIR: join(dir, "env"),
    ANYWH_THEMES_DIR: join(dir, "themes"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relay.stdout.on("data", (chunk) => (relayLog += chunk));
relay.stderr.on("data", (chunk) => (relayLog += chunk));

let exitCode = 1;
let socket;
try {
  await waitFor(() => relayLog.includes(String(port)) || relay.exitCode !== null, 15_000, "relay boot");
  if (relay.exitCode !== null) throw new Error(`relay exited early:\n${relayLog}`);

  const events = [];
  let prompt;
  let resolved = false;
  let reAsked = false;
  let turnEnded = 0;
  socket = new WebSocket(`ws://127.0.0.1:${port}/?session=long-approval-${Date.now()}`);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "choice_prompt") {
      // A second prompt for the same Write means the CLI cut the first
      // pending call (at 60 s without `timeout`) and retried it.
      if (prompt) reAsked = true;
      prompt = message;
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
    if (reAsked) {
      throw new Error(`FAIL: the CLI cut the pending approval and asked again after ${(elapsed / 1000).toFixed(1)}s`);
    }
    if (elapsed >= nextTick) {
      log(`still pending after ${(elapsed / 1000).toFixed(0)}s of ${(WAIT_MS / 1000).toFixed(0)}s`);
      nextTick += 15_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (reAsked) throw new Error("FAIL: the CLI cut the pending approval and asked again");
  if (turnEnded > 0 || resolved) throw new Error("FAIL: approval resolved on its own before the answer");

  log(`answering approve after ${((Date.now() - promptAt) / 1000).toFixed(1)}s`);
  const question = prompt.questions[0];
  socket.send(
    JSON.stringify({
      type: "choice_answer",
      promptId: prompt.promptId,
      answers: [{ question: question.question, selected: ["approve"] }],
    }),
  );

  await waitFor(() => turnEnded > 0, 90_000, "turn_ended after approval");
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
  socket?.close();
  if (relay.exitCode === null) {
    relay.kill("SIGTERM");
    await new Promise((resolve) => relay.once("exit", resolve));
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
