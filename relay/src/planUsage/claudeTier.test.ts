import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeAccountFilePath, extractClaudeAccount } from "./claudeTier.js";

test("extracts the tiers and the identity, by key", () => {
  assert.deepEqual(
    extractClaudeAccount({
      oauthAccount: {
        accountUuid: "acc",
        organizationUuid: "org",
        organizationRateLimitTier: "default_claude_max_5x",
        userRateLimitTier: null,
        seatTier: "team_tier_1",
        organizationType: "claude_max",
      },
    }),
    {
      tiers: { userRateLimitTier: null, organizationRateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1", organizationType: "claude_max" },
      identity: { accountUuid: "acc", organizationUuid: "org" },
    },
  );
});

test("nothing but the known keys comes out, whatever else oauthAccount holds", () => {
  const extracted = extractClaudeAccount({
    oauthAccount: { accountUuid: "acc", emailAddress: "a@example.invalid", accessToken: "sk-ant-secret", displayName: "Someone" },
    userID: "install-id",
  });
  const serialized = JSON.stringify(extracted);
  for (const leaked of ["example.invalid", "sk-ant", "Someone", "install-id", "emailAddress", "accessToken"]) {
    assert.ok(!serialized.includes(leaked), leaked);
  }
});

test("wrong types are null, and no oauthAccount is undefined", () => {
  assert.deepEqual(extractClaudeAccount({ oauthAccount: { accountUuid: 3, organizationRateLimitTier: "" } })?.identity, { accountUuid: null, organizationUuid: null });
  assert.equal(extractClaudeAccount({}), undefined);
  assert.equal(extractClaudeAccount({ oauthAccount: "x" }), undefined);
  assert.equal(extractClaudeAccount(null), undefined);
});

test("path: CLAUDE_CONFIG_DIR wins over the profile's home", () => {
  assert.equal(claudeAccountFilePath("/h", {}), "/h/.claude.json");
  assert.equal(claudeAccountFilePath("/h", { CLAUDE_CONFIG_DIR: "/c" }), "/c/.claude.json");
  assert.equal(claudeAccountFilePath("/h", { CLAUDE_CONFIG_DIR: "" }), "/h/.claude.json");
});
