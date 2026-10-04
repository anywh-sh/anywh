import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session/sessionStore.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the reasoning-effort
// pick, over the real WebSocket protocol and the real sessions file. The
// fake `claude` answers the catalog probe with per-model
// `supportedEffortLevels` (fake-sonnet has no `xhigh`, claude-fake-opus-8
// takes no effort at all) and echoes a received `--effort` in its reply.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function hasClaudeCatalog(message: Record<string, unknown>): boolean {
  const catalogs = message.catalogs as Record<string, { options: unknown[] }> | undefined;
  return message.type === "model_catalogs_state" && (catalogs?.claude?.options.length ?? 0) > 0;
}

/** Connects and waits for the boot probe's catalog, which the effort rules depend on. */
async function connectWithCatalog(sessionId: string) {
  return connectSessionAndCollectUntil(server.port, sessionId, hasClaudeCatalog);
}

function lastEffortState(messages: Record<string, unknown>[]): unknown {
  return messages.filter((message) => message.type === "effort_state").at(-1)?.effort;
}

test("a fresh session has no effort; set_effort is broadcast, persisted, and applied to the spawn", async () => {
  const { socket, messages: burst } = await connectWithCatalog("session-effort-set");
  assert.equal(lastEffortState(burst), null);

  socket.send(JSON.stringify({ type: "set_model", model: "fake-opus" }));
  socket.send(JSON.stringify({ type: "set_effort", effort: "xhigh" }));
  const ack = await collectUntil(socket, (message) => message.type === "effort_state" && message.effort === "xhigh");
  assert.equal(lastEffortState(ack), "xhigh");

  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.equal(reloaded.getEffort("session-effort-set", "claude"), "xhigh", "the pick survives a relay restart");

  sendUserMessage(socket, "hello");
  const turn = await collectUntil(socket, isTurnEnded);
  assert.ok(JSON.stringify(turn).includes("[effort=xhigh]"), "the CLI got --effort xhigh");
  socket.close();

  // A new connection (another tab, or after a restart) sees the persisted pick in its burst.
  const { socket: again, messages } = await connectSessionAndCollectUntil(server.port, "session-effort-set", (message) => message.type === "effort_state");
  assert.equal(lastEffortState(messages), "xhigh");
  again.close();
});

test("an effort the effective model doesn't list is refused and the current state re-broadcast", async () => {
  const { socket } = await connectWithCatalog("session-effort-refused");
  socket.send(JSON.stringify({ type: "set_model", model: "fake-sonnet" }));
  socket.send(JSON.stringify({ type: "set_effort", effort: "xhigh" }));
  const messages = await collectUntil(socket, (message) => message.type === "effort_state");
  assert.equal(lastEffortState(messages), null, "fake-sonnet has no xhigh");
  socket.close();
});

test("changing to a model that doesn't take the picked effort resets it; one that does keeps it", async () => {
  const { socket } = await connectWithCatalog("session-effort-reset");
  socket.send(JSON.stringify({ type: "set_model", model: "fake-opus" }));
  socket.send(JSON.stringify({ type: "set_effort", effort: "xhigh" }));
  await collectUntil(socket, (message) => message.type === "effort_state" && message.effort === "xhigh");

  socket.send(JSON.stringify({ type: "set_model", model: "fake-sonnet" }));
  const reset = await collectUntil(socket, (message) => message.type === "effort_state");
  assert.equal(lastEffortState(reset), null, "xhigh isn't on fake-sonnet");

  socket.send(JSON.stringify({ type: "set_effort", effort: "high" }));
  await collectUntil(socket, (message) => message.type === "effort_state" && message.effort === "high");
  socket.send(JSON.stringify({ type: "set_model", model: "fake-opus" }));
  // `model_state` arrives with no effort change after it: the pick is still valid.
  sendUserMessage(socket, "hi");
  const turn = await collectUntil(socket, isTurnEnded);
  assert.equal(lastEffortState(turn), undefined, "no effort_state emitted: still valid");
  assert.ok(JSON.stringify(turn).includes("[effort=high]"));

  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.equal(reloaded.getEffort("session-effort-reset", "claude"), "high");
  socket.close();
});

test("set_effort null clears the pick, and no --effort reaches the CLI", async () => {
  const { socket } = await connectWithCatalog("session-effort-clear");
  socket.send(JSON.stringify({ type: "set_model", model: "fake-opus" }));
  socket.send(JSON.stringify({ type: "set_effort", effort: "low" }));
  await collectUntil(socket, (message) => message.type === "effort_state" && message.effort === "low");
  socket.send(JSON.stringify({ type: "set_effort", effort: null }));
  await collectUntil(socket, (message) => message.type === "effort_state" && message.effort === null);

  sendUserMessage(socket, "hi");
  const turn = await collectUntil(socket, isTurnEnded);
  assert.ok(!JSON.stringify(turn).includes("[effort="));
  const reloaded = new SessionStore(process.env.RELAY_SESSIONS_FILE!, server.homeDir);
  assert.equal(reloaded.getEffort("session-effort-clear", "claude"), undefined);
  socket.close();
});
