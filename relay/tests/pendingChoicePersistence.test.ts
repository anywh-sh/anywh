import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { SessionManager as SessionManagerType } from "../src/session/sessionManager.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): a deferred
// `present_choice` question can stay unanswered for days, so it must be
// persisted in the sessions file and come back after a relay restart. A
// restart is simulated by building a brand new SessionStore + SessionManager
// over a copy of the file the live server wrote — exactly what `server.ts`
// does at boot — and connecting to the reloaded session.

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

type Sent = { type: string; promptId?: string; questions?: { question: string }[]; event?: { type?: string } };

/** A freshly restarted relay over a COPY of the sessions file the live
 * server wrote: the copy means the old store can never write over what the
 * "new process" reads (two writers on one file), and the live server is idle
 * (its WebSocket is closed and its turn ended) so the snapshot is final. */
function restart(sessionId: string, tamper?: (records: Record<string, Record<string, unknown>>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-restart-"));
  const file = join(dir, "sessions.json");
  const records = JSON.parse(readFileSync(process.env.RELAY_SESSIONS_FILE!, "utf8")) as Record<string, Record<string, unknown>>;
  tamper?.(records);
  writeFileSync(file, JSON.stringify(records));
  const store = new SessionStore(file, server.homeDir);
  const manager = new SessionManager(undefined, store, buildRegistry([claudeRuntimeDef]));
  const sent: Sent[] = [];
  const socket = { send: (data: string) => sent.push(JSON.parse(data) as Sent), readyState: 1, OPEN: 1, on: () => {}, close: () => {} } as unknown as WebSocket;
  const session = manager.getOrCreate(sessionId);
  session.addClient(socket);
  return {
    sent,
    session,
    /** `addClient` only registers the socket for broadcasts once the history replay is done (`caught_up`). */
    connected: async () => {
      for (let i = 0; i < 200 && !sent.some((m) => m.type === "caught_up"); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(sent.some((m) => m.type === "caught_up"), "the restarted session never finished connecting the client");
    },
    storedChoice: () => (JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingChoice?: unknown }>)[sessionId]?.pendingChoice,
    cleanup: () => {
      manager.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function messagesAfterRestart(sessionId: string): Sent[] {
  const restarted = restart(sessionId);
  restarted.cleanup();
  return restarted.sent;
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

test("answering a rehydrated question after a restart enqueues the follow-up turn", async () => {
  const { socket, promptId } = await askAndEndTurn("session-pending-answer-after-restart");
  socket.close();

  const restarted = restart("session-pending-answer-after-restart");
  try {
    process.env.FAKE_CLAUDE_REPLY = "Rewriting.";
    await restarted.connected();
    const accepted = restarted.session.answerChoice(promptId, [{ question: "Which approach?", selected: ["Rewrite from scratch"] }]);
    assert.equal(accepted, true);
    await restarted.session.waitForIdle();
    assert.ok(restarted.sent.some((m) => m.type === "choice_resolved" && m.promptId === promptId));
    assert.ok(restarted.sent.some((m) => m.type === "agent_event" && m.event?.type === "turn_ended"), "the answer must have run a follow-up turn");
    assert.equal(restarted.storedChoice(), undefined, "the record must be cleared once answered");
  } finally {
    restarted.cleanup();
  }
});

test("a persisted question whose session has no conversation left is dropped on rehydration, record included", async () => {
  const { socket } = await askAndEndTurn("session-pending-orphan");
  socket.close();

  const restarted = restart("session-pending-orphan", (records) => {
    records["session-pending-orphan"].sessionId = {};
  });
  try {
    assert.equal(restarted.sent.some((m) => m.type === "choice_prompt"), false);
    assert.equal(restarted.storedChoice(), undefined);
  } finally {
    restarted.cleanup();
  }
});

test("switching agent dismisses the question and clears the persisted record", async () => {
  const { socket, promptId } = await askAndEndTurn("session-pending-agent-switch");

  socket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));
  const messages = await collectUntil(socket, (m) => m.type === "permission_mode_state");
  socket.close();

  assert.ok(messages.some((m) => m.type === "choice_resolved" && m.promptId === promptId), "other devices must be told the card is gone");
  assert.equal(messagesAfterRestart("session-pending-agent-switch").some((m) => m.type === "choice_prompt"), false);
});
