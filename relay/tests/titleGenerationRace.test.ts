import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the Trello #26
// bug: after `/clear`, the new conversation's title sometimes never showed
// up. Root cause: `SharedSession.clearConversation()` re-arms `onFirstPrompt`
// on the SAME live session instead of allocating a fresh one, so a slow
// `generateTitle()` call started before the clear can still be in flight
// when the new conversation's own (faster) call finishes — and
// `SessionManager`'s `onFirstPrompt` closure (sessionManager.ts) used to
// write whichever one resolved, last, unconditionally. `FAKE_CLAUDE_REPLY`
// distinguishes which probe answered; `FAKE_CLAUDE_TITLE_DELAY_MS` (fake
// claude fixture) makes the race deterministic instead of hoping to land it.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_TITLE_DELAY_MS;
  delete process.env.FAKE_CLAUDE_REPLY;
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_TITLE_DELAY_MS;
  delete process.env.FAKE_CLAUDE_REPLY;
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

async function waitForTitle(sessionId: string, predicate: (title: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string | undefined;
  for (;;) {
    const body = (await (await fetch(httpUrl("/sessions"))).json()) as { sessions: { id: string; title: string }[] };
    const found = body.sessions.find((session) => session.id === sessionId);
    lastSeen = found?.title;
    if (found && predicate(found.title)) return found.title;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} title never matched, last seen: ${lastSeen}`);
    await new Promise((wait) => setTimeout(wait, 25));
  }
}

test("/clear started before the old title-generation probe resolves: the new conversation's title wins, the stale one doesn't overwrite it", async () => {
  const sessionId = "title-race-clear";
  const socket = await connectSession(server.port, sessionId);

  // Message A's title probe is held back well past the point where the
  // clear + message B's own (fast) probe will have already resolved.
  process.env.FAKE_CLAUDE_TITLE_DELAY_MS = "300";
  process.env.FAKE_CLAUDE_REPLY = "Title A";
  sendUserMessage(socket, "first conversation");
  await collectUntil(socket, isTurnEnded);

  socket.send(JSON.stringify({ type: "clear_conversation" }));

  delete process.env.FAKE_CLAUDE_TITLE_DELAY_MS;
  process.env.FAKE_CLAUDE_REPLY = "Title B";
  sendUserMessage(socket, "second conversation");
  await collectUntil(socket, isTurnEnded);

  // Before the fix, this hung until the timeout: B's `onFirstPrompt` guard
  // (`sessionStore.getTitle(id) !== null`) saw A's stale write land first
  // and never even started B's `generateTitle` call.
  const titleAfterB = await waitForTitle(sessionId, (title) => title.length > 0);
  assert.equal(titleAfterB, "Title B", "the post-/clear conversation should get its own title, not be blocked by the pre-clear one");

  // A's probe resolves ~300ms after B's — give it time to land late, then
  // confirm it didn't stomp B's title on the way in.
  await new Promise((wait) => setTimeout(wait, 400));
  const finalTitle = await waitForTitle(sessionId, () => true);
  assert.equal(finalTitle, "Title B", "a stale, pre-/clear title-generation result must not overwrite the new conversation's title once it resolves late");

  socket.close();
});

test("a manual rename that lands before a slow title-generation probe resolves is not overwritten by it", async () => {
  const sessionId = "title-race-rename";
  const socket = await connectSession(server.port, sessionId);

  process.env.FAKE_CLAUDE_TITLE_DELAY_MS = "300";
  process.env.FAKE_CLAUDE_REPLY = "Generated title";
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);

  const renameResponse = await fetch(httpUrl("/sessions/rename"), {
    method: "POST",
    body: JSON.stringify({ id: sessionId, title: "Renamed by hand" }),
  });
  assert.equal(renameResponse.status, 200);

  // The generation probe resolves ~300ms after the rename — confirm it
  // never overwrites the manual title once it lands.
  await new Promise((wait) => setTimeout(wait, 400));
  const finalTitle = await waitForTitle(sessionId, () => true);
  assert.equal(finalTitle, "Renamed by hand", "a title-generation result that resolves after a manual rename must not overwrite it");

  socket.close();
});
