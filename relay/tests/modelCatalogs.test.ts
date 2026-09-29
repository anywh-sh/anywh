import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { connectSessionAndCollectUntil } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the relay's real
// boot — `detectRuntimes`, then `probeModelCatalog` driven by the Claude
// def's own `models` — against the fake `claude` binary, observed on the
// wire. Codex isn't installed where this runs, so its catalog is simply
// absent rather than an empty entry.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

test("model_catalogs_state carries each installed agent's catalog as its CLI lists it", async () => {
  const { messages } = await connectSessionAndCollectUntil(
    server.port,
    "session-model-catalogs",
    (message) => message.type === "model_catalogs_state",
  );

  const state = messages.at(-1) as { catalogs: Record<string, { options: { id: string; label: string }[]; defaultId?: string }> };
  assert.deepEqual(
    state.catalogs.claude?.options.map((option) => option.label),
    ["Fake Sonnet 9", "Fake Opus 9", "Fake Opus 8"],
    "the CLI's own names, its 'default' pseudo-entry not among them",
  );
  assert.equal(state.catalogs.claude?.defaultId, "fake-opus", "the concrete entry the default resolves to");
});
