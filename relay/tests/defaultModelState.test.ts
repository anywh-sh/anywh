import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connectSessionAndCollectUntil } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the relay's real boot
// probes (`detectDefaultModel` + `resolveModelAliases`) against the fake
// `claude` binary, observed on the wire. Pins the two-round shape: the
// versioned per-alias names arrive in a later `default_model_state` than the
// default label, so the label never waits on the slower round.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("default_model_state eventually carries every alias's versioned name, skipping 'default'", async () => {
  const { messages } = await connectSessionAndCollectUntil(
    server.port,
    "session-default-model-state",
    (message) =>
      message.type === "default_model_state" &&
      Object.keys((message.resolved as Record<string, string> | undefined) ?? {}).length > 0,
  );

  const last = messages.at(-1) as { label: string; available: string[]; resolved: Record<string, string> };
  assert.equal(last.label, "Sonnet 5", "the '(default)' marker is dropped, the version kept");
  assert.equal(last.resolved.opus, "Fake opus 9.9");
  assert.equal(last.resolved["sonnet[1m]"], "Fake sonnet[1m] 9.9");
  assert.equal(last.resolved.default, undefined);
  assert.deepEqual(
    Object.keys(last.resolved).sort(),
    last.available.filter((alias) => alias !== "default").sort(),
  );
});
