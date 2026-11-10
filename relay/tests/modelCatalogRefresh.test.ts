import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSessionAndCollectUntil } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the relay's real
// boot and refresh path against the fake `claude`, whose catalog this test
// rewrites while the relay runs — the way a CLI's list moves under a relay
// that has been up for days. A TTL of 0 makes every connection re-probe.

const DEFAULT_MODELS = [
  { value: "default", resolvedModel: "claude-fake-opus-9", displayName: "Default (recommended)" },
  { value: "fake-opus", resolvedModel: "claude-fake-opus-9", displayName: "Fake Opus 9" },
];
const NEWER_MODELS = [...DEFAULT_MODELS, { value: "claude-fake-fable-9-2", resolvedModel: "claude-fake-fable-9-2", displayName: "Fake Fable 9.2" }];

let server: TestServer;
let dir: string;
let modelsFile: string;

type CatalogState = { type: string; catalogs: Record<string, { options: { label: string }[] }> };
const labelsOf = (message: Record<string, unknown>): string[] => (message as CatalogState).catalogs?.claude?.options.map((option) => option.label) ?? [];
const isCatalogWith =
  (label: string) =>
  (message: Record<string, unknown>): boolean =>
    message.type === "model_catalogs_state" && labelsOf(message).includes(label);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-catalog-refresh-"));
  modelsFile = join(dir, "models.json");
  writeFileSync(modelsFile, JSON.stringify(DEFAULT_MODELS));
  process.env.FAKE_CLAUDE_MODELS_FILE = modelsFile;
  process.env.RELAY_MODEL_CATALOG_TTL_MS = "0";
  server = await startTestServer();
});

after(async () => {
  await server.close();
  delete process.env.FAKE_CLAUDE_MODELS_FILE;
  delete process.env.RELAY_MODEL_CATALOG_TTL_MS;
  rmSync(dir, { recursive: true, force: true });
});

test("a catalog that changes under a running relay reaches a client that was already connected", async () => {
  const { socket: watcher } = await connectSessionAndCollectUntil(server.port, "catalog-watcher", isCatalogWith("Fake Opus 9"));
  let other: { close: () => void } | undefined;
  try {
    writeFileSync(modelsFile, JSON.stringify(NEWER_MODELS));
    // A new connection is what finds the catalog due and probes again.
    const updated = collectUntil(watcher, isCatalogWith("Fake Fable 9.2"), 10_000);
    other = (await connectSessionAndCollectUntil(server.port, "catalog-trigger", (message) => message.type === "model_catalogs_state")).socket;
    const messages = await updated;
    assert.deepEqual(labelsOf(messages.at(-1)!), ["Fake Opus 9", "Fake Fable 9.2"]);
  } finally {
    other?.close();
    watcher.close();
  }
});
