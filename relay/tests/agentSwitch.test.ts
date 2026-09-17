import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSessionAndCollectUntil, findAgentEvent, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): `set_agent` driven
// over the real WebSocket protocol, against the real relay (server.ts's
// registry already carries both claudeRuntimeDef and codexRuntimeDef —
// SELECTABLE_AGENT_IDS only gates GET /host-info, not SessionManager.setAgent
// itself, so this is exercisable before that flip lands). Never sends a real
// Codex turn: CodexSessionDriver only spawns its daemon lazily on the first
// sendTurn (defs/codexDriver.ts), so switching TO Codex and never turning is
// safe without the real `codex` binary installed.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("the connection burst includes agent_state, defaulting to claude", async () => {
  const { socket, messages: burst } = await connectSessionAndCollectUntil(server.port, "session-agent-burst", (message) => message.type === "caught_up");
  const agentState = burst.find((message) => message.type === "agent_state");
  assert.equal(agentState?.agentId, "claude");
  socket.close();
});

test("set_agent switches the driver, broadcasts agent_state and the new agent's own permission modes", async () => {
  const { socket } = await connectSessionAndCollectUntil(server.port, "session-agent-switch", (message) => message.type === "caught_up");

  socket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));

  const messages = await collectUntil(socket, (message) => message.type === "permission_mode_state");
  const agentState = messages.find((message) => message.type === "agent_state");
  const modeState = messages.find((message) => message.type === "permission_mode_state") as { mode: string; available: { id: string }[] } | undefined;

  assert.equal(agentState?.agentId, "codex");
  assert.equal(modeState?.mode, "workspace-write", "Codex's own default mode, not Claude's");
  assert.deepEqual(
    modeState?.available.map((mode) => mode.id),
    ["read-only", "workspace-write", "full-access"],
  );

  socket.close();
});

test("set_agent with an id the registry doesn't recognize is a silent no-op", async () => {
  const { socket, messages: burst } = await connectSessionAndCollectUntil(server.port, "session-agent-unknown", (message) => message.type === "caught_up");
  const initialAgentState = burst.find((message) => message.type === "agent_state");
  assert.equal(initialAgentState?.agentId, "claude");

  socket.send(JSON.stringify({ type: "set_agent", agentId: "not-a-real-agent" }));
  // Nothing to wait on (no broadcast fires for a no-op) — a second, real
  // message round-trips instead, proving the connection is still alive and
  // still on "claude" rather than stuck or silently switched.
  socket.send(JSON.stringify({ type: "set_draft", draft: "still here" }));
  const messages = await collectUntil(socket, (message) => message.type === "draft_state");
  assert.ok(!messages.some((message) => message.type === "agent_state"), "an unrecognized agent id must not broadcast any agent_state change");

  socket.close();
});

test("switching agents mid-session doesn't touch the transcript a prior turn already produced", async () => {
  const socket = await connectSessionAndCollectUntil(server.port, "session-agent-history", (message) => message.type === "caught_up").then((r) => r.socket);

  sendUserMessage(socket, "hello before switching");
  await collectUntil(socket, isTurnEnded);
  socket.close();

  const secondSocket = await connectSessionAndCollectUntil(server.port, "session-agent-history", (message) => message.type === "caught_up").then((r) => r.socket);
  secondSocket.send(JSON.stringify({ type: "set_agent", agentId: "codex" }));
  await collectUntil(secondSocket, (message) => message.type === "permission_mode_state");
  secondSocket.close();

  const { messages: thirdBurst } = await connectSessionAndCollectUntil(server.port, "session-agent-history", (message) => message.type === "caught_up");
  const historyPage = thirdBurst.find((message) => message.type === "history_page") as { messages: Record<string, unknown>[] } | undefined;
  assert.ok(historyPage, "expected a history_page in the burst");
  assert.ok(
    findAgentEvent(historyPage.messages, "text"),
    "the turn sent before switching agents must still be in the session's history, not reset by the agent switch",
  );
});
