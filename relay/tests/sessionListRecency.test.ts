import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, connectSessionListWatch, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the one piece of
// wire data the unified session list needs and `GET /sessions` never carried:
// a per-session timestamp. The client groups the sidebar by recency
// ("today" / "yesterday" / "7 days"), and `{id, title}` alone gives it
// nothing to group on — the ordering the relay already applies is lost the
// moment sessions from several profiles are merged into one list.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

interface ListedSession {
  id: string;
  title: string;
  lastActiveAt: number;
}

async function listSessions(): Promise<ListedSession[]> {
  const body = (await (await fetch(httpUrl("/sessions"))).json()) as { sessions: ListedSession[] };
  return body.sessions;
}

/** One full turn against the fake `claude`, which is also what makes the
 * relay `touch()` the session and generate its title — i.e. the only way a
 * session gets into `GET /sessions` at all. */
async function runTurn(sessionId: string, text: string): Promise<void> {
  const socket = await connectSession(server.port, sessionId);
  sendUserMessage(socket, text);
  await collectUntil(socket, isTurnEnded);
  socket.close();
}

/** Explicit synchronization rather than a fixed sleep (skill's "Determinism"
 * section): the title arrives from a `-p` call that runs in parallel with
 * the turn, so a session can finish its turn a beat before it shows up in
 * the list. */
async function waitForListed(sessionId: string, timeoutMs = 5000): Promise<ListedSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await listSessions()).find((session) => session.id === sessionId);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} never appeared in GET /sessions`);
    await new Promise((wait) => setTimeout(wait, 25));
  }
}

test("GET /sessions carries lastActiveAt, and a re-used session's timestamp moves with the new turn", async () => {
  const before = Date.now();
  await runTurn("recency-older", "first session");
  const older = await waitForListed("recency-older");

  await runTurn("recency-newer", "second session");
  const newer = await waitForListed("recency-newer");

  assert.equal(typeof older.lastActiveAt, "number");
  assert.ok(
    older.lastActiveAt >= before && older.lastActiveAt <= Date.now(),
    "lastActiveAt should be the real epoch-ms moment of the turn, not a placeholder",
  );
  assert.ok(newer.lastActiveAt >= older.lastActiveAt, "the session used later should carry the later timestamp");

  // The relay already ordered `listTitled()` by this field; now that the
  // field is on the wire, the two have to agree — a client that re-sorts by
  // `lastActiveAt` must not end up with a different order than the one the
  // relay handed it.
  const listed = await listSessions();
  const ids = listed.map((session) => session.id);
  assert.ok(ids.indexOf("recency-newer") < ids.indexOf("recency-older"), "GET /sessions should stay newest-first");

  // Talking to the older session again is what `touch()` exists for: it has
  // to jump back to the top, with a timestamp strictly newer than the one it
  // reported before.
  await runTurn("recency-older", "back to the first session");
  const touched = await waitForListed("recency-older");
  assert.ok(touched.lastActiveAt > older.lastActiveAt, "a new turn should move lastActiveAt forward");

  const reordered = (await listSessions()).map((session) => session.id);
  assert.ok(reordered.indexOf("recency-older") < reordered.indexOf("recency-newer"), "the re-used session should be first again");
});

test("session_list_upsert carries lastActiveAt, and a rename reports the session's real activity instead of now", async () => {
  const watcher = await connectSessionListWatch(server.port);

  // Attached before the turn that triggers the broadcast, never after — the
  // title-generation upsert can land before `turn_ended` (parallel `-p`
  // calls, see the skill), so awaiting first would race it away.
  const titleUpsert = collectUntil(
    watcher,
    (message) => message.type === "session_list_upsert" && message.id === "recency-watched",
  );

  await runTurn("recency-watched", "hello");

  const upsert = (await titleUpsert).find((message) => message.type === "session_list_upsert")!;
  assert.equal(typeof upsert.lastActiveAt, "number");
  const listedAfterTurn = await waitForListed("recency-watched");
  assert.equal(
    upsert.lastActiveAt,
    listedAfterTurn.lastActiveAt,
    "the broadcast timestamp should be the same one GET /sessions reports for that session",
  );

  // The reason `SessionManager` reads the timestamp back from the store
  // instead of stamping `Date.now()` on every upsert: renaming does not
  // count as activity. Stamping "now" here would silently file a long-idle
  // session under "today" on every other device the moment someone fixed a
  // typo in its title.
  const renameUpsert = collectUntil(
    watcher,
    (message) => message.type === "session_list_upsert" && message.title === "renamed by hand",
  );

  // Enough of a gap that a `Date.now()` stamp would be visibly different
  // from the turn's own timestamp — without it the assertion below could
  // pass on a same-millisecond coincidence.
  await new Promise((wait) => setTimeout(wait, 30));

  const renameResponse = await fetch(httpUrl("/sessions/rename"), {
    method: "POST",
    body: JSON.stringify({ id: "recency-watched", title: "renamed by hand" }),
  });
  assert.equal(renameResponse.status, 200);

  const renamed = (await renameUpsert).find((message) => message.title === "renamed by hand")!;
  assert.equal(renamed.id, "recency-watched");
  assert.equal(
    renamed.lastActiveAt,
    listedAfterTurn.lastActiveAt,
    "a rename should report the session's existing lastActiveAt, not the moment of the rename",
  );

  watcher.close();
});
