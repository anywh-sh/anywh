import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexEverSignedInOnDisk, codexHomeDir, hasCodexAuthFile, hasCodexSessions } from "./codexHome.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "anywh-codex-home-"));
}

test("CODEX_HOME wins over <home>/.codex", () => {
  assert.equal(codexHomeDir("/h", {}), "/h/.codex");
  assert.equal(codexHomeDir("/h", { CODEX_HOME: "/c" }), "/c");
});

test("logged in only when auth.json exists as a file", async () => {
  const dir = home();
  assert.equal(await hasCodexAuthFile(dir, {}), false);
  mkdirSync(join(dir, ".codex"));
  assert.equal(await hasCodexAuthFile(dir, {}), false);
  mkdirSync(join(dir, ".codex", "auth.json"));
  assert.equal(await hasCodexAuthFile(dir, {}), false);

  const custom = home();
  writeFileSync(join(custom, "auth.json"), "{}");
  assert.equal(await hasCodexAuthFile(dir, { CODEX_HOME: custom }), true);
});

test("ever signed in on disk: auth.json, or a non-empty sessions/ — never the home or its databases alone", async () => {
  // The trabalho profile's case: an app-server ran there without a login.
  const dir = home();
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".codex", "state_5.sqlite"), "");
  writeFileSync(join(dir, ".codex", "installation_id"), "x");
  assert.equal(await codexEverSignedInOnDisk(dir, {}), false);
  mkdirSync(join(dir, ".codex", "sessions"));
  assert.equal(await hasCodexSessions(dir, {}), false);
  assert.equal(await codexEverSignedInOnDisk(dir, {}), false);

  mkdirSync(join(dir, ".codex", "sessions", "2026"));
  assert.equal(await hasCodexSessions(dir, {}), true);
  assert.equal(await codexEverSignedInOnDisk(dir, {}), true);

  const loggedIn = home();
  mkdirSync(join(loggedIn, ".codex"));
  writeFileSync(join(loggedIn, ".codex", "auth.json"), "{}");
  assert.equal(await codexEverSignedInOnDisk(loggedIn, {}), true);
  // CODEX_HOME is where both are looked for.
  assert.equal(await codexEverSignedInOnDisk(dir, { CODEX_HOME: join(home(), "empty") }), false);
});
