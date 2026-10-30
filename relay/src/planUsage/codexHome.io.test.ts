import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHomeDir, hasCodexAuthFile } from "./codexHome.js";

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
