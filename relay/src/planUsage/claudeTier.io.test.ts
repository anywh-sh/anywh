import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAccountFileReader } from "./claudeTier.js";

const FILE = {
  userID: "install-id-redacted",
  oauthAccount: {
    accountUuid: "acc-1",
    organizationUuid: "org-1",
    emailAddress: "a@example.invalid",
    organizationRateLimitTier: "default_claude_max_5x",
    userRateLimitTier: null,
    accessToken: "sk-ant-oat-not-a-real-token",
  },
};

function home(): string {
  return mkdtempSync(join(tmpdir(), "anywh-claude-tier-"));
}

test("reads the tiers and identity from <home>/.claude.json, and nothing else", async () => {
  const dir = home();
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(FILE));
  const read = createClaudeAccountFileReader();
  const account = await read(dir, { env: {} });
  assert.equal(account?.tiers.organizationRateLimitTier, "default_claude_max_5x");
  assert.deepEqual(account?.identity, { accountUuid: "acc-1", organizationUuid: "org-1" });
  const serialized = JSON.stringify(account);
  for (const leaked of ["sk-ant", "example.invalid", "install-id"]) assert.ok(!serialized.includes(leaked), leaked);
});

test("follows a symlinked .claude.json (the trabalho profile's layout)", async () => {
  const dir = home();
  const target = join(home(), "claude-mode");
  mkdirSync(target);
  writeFileSync(join(target, ".claude.json"), JSON.stringify(FILE));
  symlinkSync(join(target, ".claude.json"), join(dir, ".claude.json"));
  assert.equal((await createClaudeAccountFileReader()(dir, { env: {} }))?.identity.accountUuid, "acc-1");
});

test("CLAUDE_CONFIG_DIR is read instead of the home", async () => {
  const dir = home();
  const config = home();
  writeFileSync(join(config, ".claude.json"), JSON.stringify(FILE));
  assert.equal(await createClaudeAccountFileReader()(dir, { env: {} }), undefined);
  assert.equal((await createClaudeAccountFileReader()(dir, { env: { CLAUDE_CONFIG_DIR: config } }))?.identity.organizationUuid, "org-1");
});

test("a half-written file is retried once, then falls back without caching the failure", async () => {
  const dir = home();
  const path = join(dir, ".claude.json");
  const read = createClaudeAccountFileReader();

  writeFileSync(path, JSON.stringify(FILE).slice(0, 40));
  assert.equal(await read(dir, { env: {}, retryDelayMs: 1 }), undefined);
  writeFileSync(path, JSON.stringify(FILE));
  assert.equal((await read(dir, { env: {} }))?.identity.accountUuid, "acc-1");

  // Finished while the reader waits for its retry.
  const other = home();
  writeFileSync(join(other, ".claude.json"), "{\"oauthAccount\":");
  setTimeout(() => writeFileSync(join(other, ".claude.json"), JSON.stringify(FILE)), 30);
  assert.equal((await createClaudeAccountFileReader()(other, { env: {}, retryDelayMs: 300 }))?.identity.accountUuid, "acc-1");
});

test("missing file or no oauthAccount is undefined", async () => {
  const dir = home();
  const read = createClaudeAccountFileReader();
  assert.equal(await read(dir, { env: {} }), undefined);
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ numStartups: 3 }));
  assert.equal(await read(dir, { env: {} }), undefined);
});

test("an unchanged file (same mtime and size) is answered from the cache; a change is reread", async () => {
  const dir = home();
  const path = join(dir, ".claude.json");
  // Whole seconds, so setting the same mtime again is exact.
  const mtime = 1_793_000_000;
  writeFileSync(path, JSON.stringify(FILE));
  utimesSync(path, mtime, mtime);
  const read = createClaudeAccountFileReader();
  assert.equal((await read(dir, { env: {} }))?.identity.accountUuid, "acc-1");

  writeFileSync(path, JSON.stringify(FILE).replace("acc-1", "acc-2"));
  utimesSync(path, mtime, mtime);
  assert.equal((await read(dir, { env: {} }))?.identity.accountUuid, "acc-1");

  utimesSync(path, mtime, mtime + 5);
  assert.equal((await read(dir, { env: {} }))?.identity.accountUuid, "acc-2");
});
