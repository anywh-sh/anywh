import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { assertTurnEnded, collectUntil, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// A Kimi Code session end to end over the real WebSocket protocol, against
// the real relay and the real ACP engine; only `kimi` itself is the fake
// ACP agent (`fixtures/fake-acp-agent.mjs`, shapes of Kimi Code CLI 2.6.0),
// put first on the relay's PATH as a `kimi` wrapper.
const FAKE_ACP_AGENT = resolve(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

let server: TestServer;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-kimi-session-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "kimi"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"\n`);
  chmodSync(join(binDir, "kimi"), 0o755);
  process.env.PATH = [binDir, process.env.PATH ?? ""].join(delimiter);
  process.env.FAKE_ACP_STATE = join(dir, "acp-state.json");
  process.env.FAKE_ACP_IDLE_EXIT_MS = "1000";
  server = await startTestServer();
  // Inherited from a shell, it could put a real `kimi` ahead of the fake.
  process.env.EXTRA_PATH_DIRS = "";
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function kimiSession(sessionId: string): Promise<WebSocket> {
  const { socket } = await connectSessionAndCollectUntil(server.port, sessionId, (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  await collectUntil(socket, (message) => message.type === "permission_mode_state");
  return socket;
}

function events(messages: Record<string, unknown>[]): { type: string; [key: string]: unknown }[] {
  return messages.filter((message) => message.type === "agent_event").map((message) => message.event as { type: string });
}

test("switching to Kimi offers Kimi's own four modes", async () => {
  const { socket } = await connectSessionAndCollectUntil(server.port, "kimi-modes", (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  const messages = await collectUntil(socket, (message) => message.type === "permission_mode_state");
  const modes = messages.find((message) => message.type === "permission_mode_state") as { mode: string; available: { id: string }[] };
  assert.equal(modes.mode, "default");
  assert.deepEqual(
    modes.available.map((mode) => mode.id),
    ["default", "plan", "auto", "yolo"],
  );
  socket.close();
});

test("a turn streams Kimi's thought and reply and ends with the context it reported", async () => {
  const socket = await kimiSession("kimi-turn");
  sendUserMessage(socket, "hello kimi");
  const messages = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(messages.find(isTurnEnded), false);
  const log = events(messages);
  assert.ok(log.some((event) => event.type === "thinking"));
  assert.ok(log.some((event) => event.type === "text" && event.text === "echo: hello kimi"));
  const usage = messages.filter((message) => message.type === "context_usage_state").at(-1) as { usage?: { contextWindowSize?: number; usedTokens?: number } } | undefined;
  assert.equal(usage?.usage?.contextWindowSize, 1000);
  socket.close();
});

test("a command approval reaches the client as a choice and the answer reaches Kimi", async () => {
  const socket = await kimiSession("kimi-approval");
  sendUserMessage(socket, "[[tool]]");
  const prompted = await collectUntil(socket, (message) => message.type === "choice_prompt");
  const prompt = prompted.at(-1) as { promptId: string; questions: { options: { id?: string; label: string }[]; approval?: { tool: string; detail: string } }[] };
  assert.deepEqual(prompt.questions[0].approval, { tool: "Bash", detail: "ls" });
  assert.deepEqual(
    prompt.questions[0].options.map((option) => option.id),
    ["accept", "acceptForSession", "decline"],
  );
  socket.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: [{ question: "", selected: ["accept"] }] }));
  const rest = await collectUntil(socket, isTurnEnded);
  const log = events(rest);
  const ended = log.find((event) => event.type === "tool_ended") as { content?: string; isError?: boolean } | undefined;
  assert.equal(ended?.content, "file.txt\n");
  assert.equal(ended?.isError, false);
  assert.ok(log.some((event) => event.type === "text" && event.text === "listed"));
  socket.close();
});

test("Kimi's question tool shows as a choice card and the label picked is the answer", async () => {
  const socket = await kimiSession("kimi-question");
  sendUserMessage(socket, "[[question]]");
  const prompted = await collectUntil(socket, (message) => message.type === "choice_prompt");
  const prompt = prompted.at(-1) as { promptId: string; questions: { question: string; header?: string; options: { label: string }[] }[] };
  assert.equal(prompt.questions[0].question, "Pick one");
  assert.deepEqual(
    prompt.questions[0].options.map((option) => option.label),
    ["Red", "Blue"],
  );
  assert.ok(!events(prompted).some((event) => event.type === "tool_started"), "the question tool itself never shows as a tool card");
  socket.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: [{ question: "Pick one", selected: ["Blue"] }] }));
  const rest = await collectUntil(socket, isTurnEnded);
  assert.ok(events(rest).some((event) => event.type === "text" && event.text === "answer: Blue"));
  socket.close();
});

test("Stop ends a turn that is waiting on an approval, and the session keeps going", async () => {
  const socket = await kimiSession("kimi-stop");
  sendUserMessage(socket, "[[hang]]");
  await collectUntil(socket, (message) => message.type === "choice_prompt");
  socket.send(JSON.stringify({ type: "stop_turn" }));
  const stopped = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(stopped.find(isTurnEnded), true);
  sendUserMessage(socket, "still there?");
  const next = await collectUntil(socket, isTurnEnded);
  assert.ok(events(next).some((event) => event.type === "text" && event.text === "echo: still there?"));
  socket.close();
});

test("Kimi's model catalog reaches clients, each model with its own reasoning levels", async () => {
  // Probed in the background once detection finds `kimi`; a connection made
  // after that carries it.
  type Catalogs = { catalogs: Record<string, { options: { id: string; efforts?: { id: string }[] }[]; defaultId?: string }> };
  let state: Catalogs | undefined;
  for (let attempt = 0; attempt < 100 && !state?.catalogs.kimi; attempt++) {
    // Sent right after the connection's history burst, so after `caught_up`.
    const { socket, messages } = await connectSessionAndCollectUntil(server.port, `kimi-catalog-${attempt}`, (message) => message.type === "model_catalogs_state");
    socket.close();
    state = messages.at(-1) as Catalogs | undefined;
    if (!state?.catalogs.kimi) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const kimi = state?.catalogs.kimi;
  assert.ok(kimi, "no kimi catalog was ever published");
  assert.equal(kimi.defaultId, "m1");
  assert.deepEqual(
    kimi.options.map((option) => [option.id, option.efforts?.map((effort) => effort.id)]),
    [
      ["m1", ["low", "high", "max"]],
      ["m2", ["on", "high"]],
    ],
  );
});
