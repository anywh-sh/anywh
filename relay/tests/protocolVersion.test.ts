import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WS_PROTOCOL_VERSION } from "../src/protocol/version.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connectSessionAndCollectUntil } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the relay's real
// WebSocket connection handler, not a unit around a helper — this is the
// one place `protocol_version` is actually written to the wire.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("protocol_version is the very first message on a new connection, ahead of any session state", async () => {
  const { messages } = await connectSessionAndCollectUntil(
    server.port,
    "session-protocol-version",
    (message) => message.type === "caught_up",
  );

  assert.deepEqual(messages[0], { type: "protocol_version", version: WS_PROTOCOL_VERSION });
});
