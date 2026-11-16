import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSessionAndCollectUntil, sendUserMessage } from "./helpers/wsClient.js";

// A failed turn's `error` event carries the agent's own reading of the
// failure, through the real relay and the fake `claude`: the login lost
// mid-life is "auth" (what lets the client offer to sign back in), anything
// unrecognised stays "transient".

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  delete process.env.FAKE_CLAUDE_ERROR;
  await server.close();
});

async function failedTurn(sessionId: string, cliError: string): Promise<Record<string, unknown> | undefined> {
  process.env.FAKE_CLAUDE_ERROR = cliError;
  const { socket } = await connectSessionAndCollectUntil(server.port, sessionId, (message) => message.type === "caught_up");
  sendUserMessage(socket, "hello");
  // A failed turn ends without `turn_ended`: the idle turn state closes it.
  const messages = await collectUntil(socket, (message) => message.type === "turn_state" && message.active === false);
  socket.close();
  return messages
    .filter((message) => message.type === "agent_event")
    .map((message) => message.event as Record<string, unknown>)
    .find((event) => event.type === "error");
}

test("a turn refused for a lost login is tagged auth", async () => {
  // Claude Code's own words when it has no login.
  const error = await failedTurn("lost-login", "Not logged in · Please run /login");
  assert.equal(error?.failureClass, "auth");
  assert.match(String(error?.message), /Not logged in/);
});

test("a failure the agent's words don't explain is transient", async () => {
  const error = await failedTurn("other-failure", "Overloaded");
  assert.equal(error?.failureClass, "transient");
});
