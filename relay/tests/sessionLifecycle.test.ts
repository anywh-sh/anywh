import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session/sessionStore.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, findAgentEvent, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): boots the actual
// relay server, talks to it over a real WebSocket, and only fakes the one
// sanctioned boundary — the `claude` process itself (testServer.ts).

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("a turn streams agent_event(s) ending in text, then turn_ended", async () => {
  const socket = await connectSession(server.port, "session-a");
  sendUserMessage(socket, "hello");

  const messages = await collectUntil(socket, isTurnEnded);

  const textEvent = findAgentEvent(messages, "text");
  assert.ok(textEvent, `expected an agent_event carrying text, got: ${JSON.stringify(messages)}`);

  const turnEnded = messages.at(-1);
  assert.deepEqual(turnEnded, { type: "agent_event", event: { type: "turn_ended", stopped: false } });

  socket.close();
});

test("a second turn on the same session resumes the same claude session_id", async () => {
  const socket = await connectSession(server.port, "session-b");

  sendUserMessage(socket, "first turn");
  const firstMessages = await collectUntil(socket, isTurnEnded);
  const firstSessionId = (findAgentEvent(firstMessages, "session_id")!.event as { sessionId?: string }).sessionId;
  assert.ok(firstSessionId, "first turn should produce a session_id");

  sendUserMessage(socket, "second turn");
  const secondMessages = await collectUntil(socket, isTurnEnded);
  const secondSessionId = (findAgentEvent(secondMessages, "session_id")!.event as { sessionId?: string }).sessionId;

  // The fake `claude` echoes back `--resume <id>` as-is (fixtures/fake-claude.mjs)
  // — a stable session_id across two turns proves the relay actually passed
  // `--resume`, not just that both turns happened to work in isolation.
  assert.equal(secondSessionId, firstSessionId);

  socket.close();
});

test("a completed turn's session_id is persisted to disk, readable by a fresh SessionStore", async () => {
  const socket = await connectSession(server.port, "session-c");
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);
  socket.close();

  // Real file on real disk (RELAY_SESSIONS_FILE, set by startTestServer) —
  // re-reading it through a fresh SessionStore instance is the same
  // real-persistence check sessionStore.test.ts already uses for the
  // pure-unit side of this class.
  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.ok(reloaded.getSessionId("session-c"), "expected session-c's claude session_id to survive a reload from disk");
});
