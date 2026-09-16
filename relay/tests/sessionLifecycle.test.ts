import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session/sessionStore.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, sendUserMessage } from "./helpers/wsClient.js";

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

test("a turn streams claude_event(s) ending in a successful result, then turn_complete", async () => {
  const socket = await connectSession(server.port, "session-a");
  sendUserMessage(socket, "hello");

  const messages = await collectUntil(socket, (message) => message.type === "turn_complete");

  const resultEvent = messages.find(
    (message) => message.type === "claude_event" && (message.event as { type?: string }).type === "result",
  );
  assert.ok(resultEvent, `expected a claude_event carrying a result, got: ${JSON.stringify(messages)}`);
  assert.equal((resultEvent!.event as { is_error?: boolean }).is_error, false);

  const turnComplete = messages.at(-1);
  assert.deepEqual(turnComplete, { type: "turn_complete", stopped: false });

  socket.close();
});

test("a second turn on the same session resumes the same claude session_id", async () => {
  const socket = await connectSession(server.port, "session-b");

  sendUserMessage(socket, "first turn");
  const firstMessages = await collectUntil(socket, (message) => message.type === "turn_complete");
  const firstResult = firstMessages.find(
    (message) => message.type === "claude_event" && (message.event as { type?: string }).type === "result",
  );
  const firstSessionId = (firstResult!.event as { session_id?: string }).session_id;
  assert.ok(firstSessionId, "first turn should produce a session_id");

  sendUserMessage(socket, "second turn");
  const secondMessages = await collectUntil(socket, (message) => message.type === "turn_complete");
  const secondResult = secondMessages.find(
    (message) => message.type === "claude_event" && (message.event as { type?: string }).type === "result",
  );
  const secondSessionId = (secondResult!.event as { session_id?: string }).session_id;

  // The fake `claude` echoes back `--resume <id>` as-is (fixtures/fake-claude.mjs)
  // — a stable session_id across two turns proves the relay actually passed
  // `--resume`, not just that both turns happened to work in isolation.
  assert.equal(secondSessionId, firstSessionId);

  socket.close();
});

test("a completed turn's session_id is persisted to disk, readable by a fresh SessionStore", async () => {
  const socket = await connectSession(server.port, "session-c");
  sendUserMessage(socket, "hello");
  await collectUntil(socket, (message) => message.type === "turn_complete");
  socket.close();

  // Real file on real disk (RELAY_SESSIONS_FILE, set by startTestServer) —
  // re-reading it through a fresh SessionStore instance is the same
  // real-persistence check sessionStore.test.ts already uses for the
  // pure-unit side of this class.
  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.ok(reloaded.getSessionId("session-c"), "expected session-c's claude session_id to survive a reload from disk");
});
