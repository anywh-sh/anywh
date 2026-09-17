import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import type WebSocket from "ws";
import { collectUntil, connectSession, connectSessionListWatch, findAgentEvent, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md), continuing where
// sessionLifecycle.test.ts leaves off: the "Stop" button (interrupt) and the
// HTTP session-management routes (rename/delete/list), none of which the
// original file covers.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_HANG;
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

test("stop_turn interrupts an in-flight turn (stopped: true) without losing session continuity", async () => {
  const socket = await connectSession(server.port, "session-stop");

  process.env.FAKE_CLAUDE_HANG = "1";
  sendUserMessage(socket, "please hang");

  // Explicit synchronization on the real event stream (skill's "Determinism"
  // section) — waits for the fake claude's own `system`/`init` event (mapped
  // to `session_id`), proof the child has actually spawned and is genuinely
  // blocked waiting for SIGINT, before sending `stop_turn`. A fixed sleep
  // here would either race ahead of the spawn or pad every run with dead time.
  await collectUntil(socket, (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "session_id");
  socket.send(JSON.stringify({ type: "stop_turn" }));

  const messages = await collectUntil(socket, isTurnEnded);
  const turnEnded = messages.at(-1);
  assert.deepEqual(turnEnded, { type: "agent_event", event: { type: "turn_ended", stopped: true } });

  const sessionIdEvent = findAgentEvent(messages, "session_id");
  const sessionId = (sessionIdEvent!.event as { sessionId?: string }).sessionId;
  assert.ok(sessionId, "an interrupted turn should still report a session_id (runtimes/defs/claude/session.ts's stop() contract)");

  // A second, normal turn on the same session proves the interrupted one
  // didn't erase continuity — same invariant sessionLifecycle.test.ts checks
  // for two successful turns, here across a stop.
  delete process.env.FAKE_CLAUDE_HANG;
  sendUserMessage(socket, "are you still there");
  const secondMessages = await collectUntil(socket, isTurnEnded);
  const secondSessionId = (findAgentEvent(secondMessages, "session_id")!.event as { sessionId?: string }).sessionId;
  assert.equal(secondSessionId, sessionId);

  socket.close();
});

test("a session renamed and deleted over HTTP disappears from GET /sessions, and reconnecting to the same id starts fresh", async () => {
  const socket = await connectSession(server.port, "session-http-lifecycle");
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);

  const renameResponse = await fetch(httpUrl("/sessions/rename"), {
    method: "POST",
    body: JSON.stringify({ id: "session-http-lifecycle", title: "Minha sessão" }),
  });
  assert.equal(renameResponse.status, 200);

  const listed = (await (await fetch(httpUrl("/sessions"))).json()) as {
    sessions: { id: string; title: string; lastActiveAt: number }[];
  };
  const renamed = listed.sessions.find((entry) => entry.id === "session-http-lifecycle");
  assert.deepEqual(
    renamed && { id: renamed.id, title: renamed.title },
    { id: "session-http-lifecycle", title: "Minha sessão" },
  );
  // `lastActiveAt` (sessionListRecency.test.ts covers its semantics) travels
  // on every row of this route, including a renamed one.
  assert.equal(typeof renamed!.lastActiveAt, "number");

  const deleteResponse = await fetch(httpUrl("/sessions/delete"), {
    method: "POST",
    body: JSON.stringify({ id: "session-http-lifecycle" }),
  });
  assert.equal(deleteResponse.status, 200);

  const listedAfterDelete = (await (await fetch(httpUrl("/sessions"))).json()) as { sessions: { id: string }[] };
  assert.ok(
    !listedAfterDelete.sessions.some((entry) => entry.id === "session-http-lifecycle"),
    "a deleted session should no longer appear in GET /sessions",
  );

  // Reconnecting under the SAME id after a delete must NOT resume the old
  // claude session_id — deleteSession() drops the SessionStore entry
  // entirely (sessionManager.ts), so this is really a brand new conversation
  // that just happens to reuse the id.
  const secondSocket = await connectSession(server.port, "session-http-lifecycle");
  sendUserMessage(secondSocket, "hi again");
  const messages = await collectUntil(secondSocket, isTurnEnded);
  // The fake claude only echoes back a `--resume` id if one was passed
  // (fixtures/fake-claude.mjs); a fresh session_id here (rather than a
  // rejection) proves no `--resume` flag was sent this time.
  assert.ok((findAgentEvent(messages, "session_id")!.event as { sessionId?: string }).sessionId);

  socket.close();
  secondSocket.close();
});

test("/sessions/watch broadcasts a new session's title, and its deletion, to a client that never opened it", async () => {
  // Real bug this reproduces: a conversation started on one device (e.g.
  // mobile) only reached another device's sidebar (e.g. desktop) after a
  // reload, because the relay only pushed session_title/session_deleted to
  // clients already connected to THAT specific session's own socket.
  // `/sessions/watch` is a separate, session-agnostic channel meant to fix
  // exactly that — this watcher never connects to "session-watched-by-other"
  // at all.
  const watcher = await connectSessionListWatch(server.port);
  let chatSocket: WebSocket | undefined;

  try {
    // Attach both collectors BEFORE triggering the action that causes the
    // broadcast, not after awaiting it — the title-generation broadcast can
    // arrive before `turn_ended` (they fire from parallel `-p` calls, see
    // .anywh/skills/tests/SKILL.md), and the delete broadcast happens
    // synchronously inside the HTTP handler before the response is even sent.
    // Attaching the listener only after awaiting either would race exactly
    // like the connection-time-burst trap the skill documents for `open`.
    const upsertReceived = collectUntil(
      watcher,
      (message) => message.type === "session_list_upsert" && message.id === "session-watched-by-other",
    );

    chatSocket = await connectSession(server.port, "session-watched-by-other");
    sendUserMessage(chatSocket, "hello from another device");
    await collectUntil(chatSocket, isTurnEnded);

    // Filters by id, not just by type — the same predicate `collectUntil`
    // stopped on. `/sessions/watch` is a list-wide channel, so what lands in
    // the collected array is every session's traffic, not this test's: a
    // late `session_list_upsert` for the PREVIOUS test's session (its title
    // generation resolves out of band, after that test already passed)
    // routinely arrives first, and a `.find` that only matched on type
    // picked that one. That is the flake that hung CI on 2026-09-13 —
    // 'session-http-lifecycle' where 'session-watched-by-other' was
    // expected, roughly one run in six under parallel load.
    const upsert = (await upsertReceived).find(
      (message) => message.type === "session_list_upsert" && message.id === "session-watched-by-other",
    );
    assert.equal(upsert!.id, "session-watched-by-other");
    assert.equal(typeof upsert!.title, "string");

    const removedReceived = collectUntil(
      watcher,
      (message) => message.type === "session_list_removed" && message.id === "session-watched-by-other",
    );

    const deleteResponse = await fetch(httpUrl("/sessions/delete"), {
      method: "POST",
      body: JSON.stringify({ id: "session-watched-by-other" }),
    });
    assert.equal(deleteResponse.status, 200);

    // Same id filter, same reason: the previous test deletes its own session
    // on this very channel, so type alone does not identify this one.
    const removed = (await removedReceived).find(
      (message) => message.type === "session_list_removed" && message.id === "session-watched-by-other",
    );
    assert.deepEqual(removed, { type: "session_list_removed", id: "session-watched-by-other" });
  } finally {
    // `finally`, not two calls at the end of the happy path: an assertion
    // tripping above used to skip both closes, and a WebSocket left open
    // hangs the `after` hook (see testServer.ts's own `close`). A failing
    // test has to stay a failing test.
    chatSocket?.close();
    watcher.close();
  }
});
