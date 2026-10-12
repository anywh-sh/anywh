import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import {
  collectUntil,
  connectSession,
  connectSessionListWatch,
  connectSessionListWatchWithSnapshot,
  isTurnEnded,
  sendUserMessage,
} from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for what keeps a
// sidebar on another device in step with this relay without it ever having
// to poll: the snapshot a (re)connecting watcher gets, the liveness probe
// that tells it its socket is really still there, and the two list changes
// that used to reach only the device that caused them.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function runTurn(sessionId: string, text: string): Promise<void> {
  const socket = await connectSession(server.port, sessionId);
  sendUserMessage(socket, text);
  await collectUntil(socket, isTurnEnded);
  socket.close();
}

async function runTitledTurn(sessionId: string, text: string): Promise<void> {
  const watcher = await connectSessionListWatch(server.port);
  const titled = collectUntil(watcher, (message) => message.type === "session_list_upsert" && message.id === sessionId);
  await runTurn(sessionId, text);
  await titled;
  watcher.close();
}

test("a watcher connecting after the fact gets the whole list first, newest first", async () => {
  await runTitledTurn("sync-older", "first");
  await runTitledTurn("sync-newer", "second");

  // Everything above happened with no watcher listening — exactly the
  // position a device is in when it reconnects after its machine slept.
  const { socket, snapshot } = await connectSessionListWatchWithSnapshot(server.port);
  assert.equal(snapshot.type, "session_list_snapshot");
  const sessions = snapshot.sessions as { id: string; title: string; lastActiveAt: number }[];
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes("sync-older") && ids.includes("sync-newer"), `snapshot should list both sessions, got ${JSON.stringify(ids)}`);
  assert.ok(ids.indexOf("sync-newer") < ids.indexOf("sync-older"), "snapshot should keep GET /sessions' newest-first order");
  assert.equal(typeof sessions[0].lastActiveAt, "number");
  socket.close();
});

test("the watch socket answers a ping with a pong", async () => {
  const { socket } = await connectSessionListWatchWithSnapshot(server.port);
  const pong = collectUntil(socket, (message) => message.type === "pong");
  socket.send(JSON.stringify({ type: "ping" }));
  await pong;
  socket.close();
});

test("a new turn on an already-titled session is broadcast with its new lastActiveAt", async () => {
  await runTitledTurn("sync-touched", "hello");
  const { socket, snapshot } = await connectSessionListWatchWithSnapshot(server.port);
  const before = (snapshot.sessions as { id: string; lastActiveAt: number }[]).find((session) => session.id === "sync-touched")!;

  // Without this broadcast, only the device that sent the message moved the
  // session back to the top; every other one kept it wherever it was.
  const touched = collectUntil(
    socket,
    (message) =>
      message.type === "session_list_upsert" && message.id === "sync-touched" && (message.lastActiveAt as number) > before.lastActiveAt,
  );
  await new Promise((wait) => setTimeout(wait, 5));
  await runTurn("sync-touched", "again");
  await touched;
  socket.close();
});

test("/clear on a titled session is broadcast as a removal", async () => {
  await runTitledTurn("sync-cleared", "to be cleared");
  const { socket } = await connectSessionListWatchWithSnapshot(server.port);
  const removed = collectUntil(socket, (message) => message.type === "session_list_removed" && message.id === "sync-cleared");

  const chat = await connectSession(server.port, "sync-cleared");
  chat.send(JSON.stringify({ type: "clear_conversation" }));
  await removed;

  const listed = (await (await fetch(`http://127.0.0.1:${server.port}/sessions`)).json()) as { sessions: { id: string }[] };
  assert.ok(!listed.sessions.some((session) => session.id === "sync-cleared"), "GET /sessions should agree the row is gone");
  chat.close();
  socket.close();
});
