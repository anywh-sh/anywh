import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// RELAY_PUSH_DISABLED=1 removes the feature: the registration routes answer
// like a relay that never had them, which is what tells a client to keep
// notifying locally.

let server: TestServer;
before(async () => {
  process.env.RELAY_PUSH_DISABLED = "1";
  server = await startTestServer();
});
after(async () => {
  await server.close();
});

test("the push routes don't exist when push is disabled", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  const body = JSON.stringify({ gatewayUrl: "https://gw.example.test/n", pushKey: "k" });
  assert.equal((await fetch(`${base}/push/devices`)).status, 426);
  assert.equal((await fetch(`${base}/push/devices/3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e`, { method: "PUT", body })).status, 426);
});
