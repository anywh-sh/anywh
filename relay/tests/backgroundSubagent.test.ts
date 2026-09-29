import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for a background
// subagent crossing the whole stack: the fake `claude` prints what the real
// CLI printed for a `run_in_background` Agent call (fixtures/fake-claude.mjs's
// FAKE_CLAUDE_BACKGROUND_SUBAGENT), and the client-facing WebSocket has to
// carry its lifecycle as `subagent` events and tag its own work with
// `parentToolUseId`, so the client can keep it out of the conversation.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_BACKGROUND_SUBAGENT;
});

interface WireEvent {
  type: string;
  toolUseId?: string;
  parentToolUseId?: string;
  status?: string;
  background?: boolean;
  activity?: string;
  text?: string;
}

test("a background subagent's lifecycle and own work reach the client, told apart from the main thread", async () => {
  const socket = await connectSession(server.port, "session-background-subagent");

  process.env.FAKE_CLAUDE_BACKGROUND_SUBAGENT = "1";
  sendUserMessage(socket, "read a.txt in the background");
  const messages = await collectUntil(socket, isTurnEnded);
  const events = messages.filter((m) => m.type === "agent_event").map((m) => m.event as WireEvent);

  const lifecycle = events.filter((e) => e.type === "subagent");
  assert.deepEqual(
    lifecycle.map(({ toolUseId, status, background, activity }) => ({ toolUseId, status, background, activity })),
    [
      { toolUseId: "toolu_bg_agent", status: "running", background: true, activity: undefined },
      { toolUseId: "toolu_bg_agent", status: "running", background: undefined, activity: "Reading a.txt" },
      { toolUseId: "toolu_bg_agent", status: "completed", background: undefined, activity: undefined },
    ],
  );

  const subagentWork = events.filter((e) => e.parentToolUseId === "toolu_bg_agent").map((e) => e.type);
  assert.deepEqual(subagentWork, ["tool_started", "tool_ended", "text"]);

  const mainText = events.filter((e) => e.type === "text" && !e.parentToolUseId).map((e) => e.text);
  assert.ok(mainText.includes("Launched it."));
  assert.ok(!mainText.includes("a.txt says alpha"));

  socket.close();
});
