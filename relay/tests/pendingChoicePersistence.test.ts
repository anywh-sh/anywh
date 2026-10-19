import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type { SessionManager as SessionManagerType } from "../src/session/sessionManager.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): a deferred
// `present_choice` question can stay unanswered for days, so it must be
// persisted in the sessions file and come back after a relay restart. A
// restart is simulated by building a brand new SessionStore + SessionManager
// over the same file the live server wrote — exactly what `server.ts` does at
// boot — and connecting to the reloaded session.

let server: TestServer;
// Loaded after `startTestServer` on purpose: the runtime defs read AGENT_BIN
// at import time, and the test server is what points it at the fake claude.
let SessionManager: typeof SessionManagerType;
let SessionStore: typeof import("../src/session/sessionStore.js").SessionStore;
let claudeRuntimeDef: typeof import("../src/runtimes/defs/claude/index.js").claudeRuntimeDef;
let buildRegistry: typeof import("../src/runtimes/registry.js").buildRegistry;

before(async () => {
  server = await startTestServer();
  ({ SessionManager } = await import("../src/session/sessionManager.js"));
  ({ SessionStore } = await import("../src/session/sessionStore.js"));
  ({ claudeRuntimeDef } = await import("../src/runtimes/defs/claude/index.js"));
  ({ buildRegistry } = await import("../src/runtimes/registry.js"));
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
  delete process.env.FAKE_CLAUDE_REPLY;
});

const QUESTIONS = [{ question: "Which approach?", options: [{ label: "Rewrite from scratch" }, { label: "Patch the existing code" }] }];

/** What a freshly restarted relay would send to a connecting device. */
function messagesAfterRestart(sessionId: string): { type: string; promptId?: string; questions?: { question: string }[] }[] {
  const store = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  const manager = new SessionManager(undefined, store, buildRegistry([claudeRuntimeDef]));
  try {
    const sent: { type: string; promptId?: string; questions?: { question: string }[] }[] = [];
    const socket = { send: (data: string) => sent.push(JSON.parse(data) as (typeof sent)[number]), readyState: 1, on: () => {}, close: () => {} } as unknown as WebSocket;
    manager.getOrCreate(sessionId).addClient(socket);
    return sent;
  } finally {
    manager.disposeAll();
  }
}

async function askAndEndTurn(sessionId: string) {
  const socket = await connectSession(server.port, sessionId);
  process.env.FAKE_CLAUDE_PRESENT_CHOICE = JSON.stringify(QUESTIONS);
  sendUserMessage(socket, "how should we do this");
  const messages = await collectUntil(socket, isTurnEnded);
  delete process.env.FAKE_CLAUDE_PRESENT_CHOICE;
  const prompt = messages.find((m) => m.type === "choice_prompt") as { promptId: string };
  assert.ok(prompt, "the question must have been published");
  return { socket, promptId: prompt.promptId };
}

test("an unanswered present_choice question reappears, same promptId, after a relay restart", async () => {
  const { socket, promptId } = await askAndEndTurn("session-pending-restart");
  socket.close();

  const restarted = messagesAfterRestart("session-pending-restart");
  const prompt = restarted.find((m) => m.type === "choice_prompt");
  assert.ok(prompt, "the pending question must survive a restart");
  assert.equal(prompt.promptId, promptId);
  assert.equal(prompt.questions![0].question, "Which approach?");
});

test("answering the question clears the persisted record", async () => {
  const { socket, promptId } = await askAndEndTurn("session-pending-answered");

  process.env.FAKE_CLAUDE_REPLY = "Rewriting.";
  socket.send(JSON.stringify({ type: "choice_answer", promptId, answers: [{ question: "Which approach?", selected: ["Rewrite from scratch"] }] }));
  await collectUntil(socket, isTurnEnded);
  socket.close();

  assert.equal(messagesAfterRestart("session-pending-answered").some((m) => m.type === "choice_prompt"), false);
});

test("moving on with a new message (discarding the stale question) clears the persisted record", async () => {
  const { socket } = await askAndEndTurn("session-pending-discarded");

  process.env.FAKE_CLAUDE_REPLY = "Sure.";
  sendUserMessage(socket, "never mind, do something else");
  await collectUntil(socket, isTurnEnded);
  socket.close();

  assert.equal(messagesAfterRestart("session-pending-discarded").some((m) => m.type === "choice_prompt"), false);
});
