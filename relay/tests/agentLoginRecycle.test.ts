import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { assertTurnEnded, collectUntil, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

const isApprovalPrompt = (message: Record<string, unknown>): boolean => message.type === "choice_prompt" && message.kind === "approval";

// A sign-in replaces the credentials an idle daemon started with: after
// `/agent-login` succeeds, a Kimi session's `kimi acp` process (the fake ACP
// agent, Kimi Code CLI 2.6.0 shapes) is let go, and the next turn runs on a
// fresh one that resumes the same conversation.
const FAKE_ACP_AGENT = resolve(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

let server: TestServer;
let dir: string;
let PIDS: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-agent-login-recycle-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "kimi"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"\n`);
  chmodSync(join(binDir, "kimi"), 0o755);
  process.env.PATH = [binDir, process.env.PATH ?? ""].join(delimiter);
  process.env.FAKE_ACP_STATE = join(dir, "acp-state.json");
  process.env.KIMI_CODE_HOME = join(dir, "kimi-home");
  PIDS = join(dir, "acp-pids");
  process.env.FAKE_ACP_PIDS = PIDS;
  server = await startTestServer();
  process.env.EXTRA_PATH_DIRS = "";
});

after(async () => {
  // The fresh daemon has no idle exit here; it would hold the test process.
  for (const pid of livePids()) process.kill(pid, "SIGTERM");
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function livePids(): number[] {
  if (!existsSync(PIDS)) return [];
  return readFileSync(PIDS, "utf8").trim().split("\n").filter(Boolean).map(Number).filter(alive);
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function signIn(runtime: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolveFrames, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/agent-login?runtime=${runtime}`);
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    socket.on("close", () => (frames.some((frame) => frame.type === "done") ? resolveFrames(frames) : reject(new Error(JSON.stringify(frames)))));
  });
}

test("a successful sign-in lets an idle session's daemon go, and the next turn resumes on a fresh one", async () => {
  const { socket } = await connectSessionAndCollectUntil(server.port, "recycle", (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  await collectUntil(socket, (message) => message.type === "permission_mode_state");
  sendUserMessage(socket, "first");
  assertTurnEnded((await collectUntil(socket, isTurnEnded)).find(isTurnEnded), false);
  // The session's daemon stays up between turns (no idle exit configured).
  await eventually(() => livePids().length > 0);
  const daemons = livePids();

  const frames = await signIn("kimi");
  assert.equal(frames.find((frame) => frame.type === "prompt")?.userCode, "FAKE-CODE");
  await eventually(() => daemons.every((pid) => !alive(pid)));

  sendUserMessage(socket, "second");
  const messages = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(messages.find(isTurnEnded), false);
  const texts = messages
    .filter((message) => message.type === "agent_event")
    .map((message) => message.event as { type: string; text?: string })
    .filter((event) => event.type === "text")
    .map((event) => event.text);
  assert.ok(texts.includes("echo: second"));
  assert.ok(livePids().some((pid) => !daemons.includes(pid)), "a new process ran the turn");
  socket.close();
});

test("a sign-in during a turn doesn't cut it short; its daemon is let go once the turn ends", async () => {
  const { socket } = await connectSessionAndCollectUntil(server.port, "recycle-mid-turn", (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  await collectUntil(socket, (message) => message.type === "permission_mode_state");
  // A turn held open on an approval.
  sendUserMessage(socket, "[[hang]]");
  await collectUntil(socket, isApprovalPrompt);
  const daemons = livePids();

  await signIn("kimi");
  // Still running: the turn is not cut short.
  assert.ok(daemons.some(alive), "the turn's daemon survives the sign-in while the turn runs");

  socket.send(JSON.stringify({ type: "stop_turn" }));
  assertTurnEnded((await collectUntil(socket, isTurnEnded)).find(isTurnEnded), true);
  await eventually(() => daemons.every((pid) => !alive(pid)));
  socket.close();
});
