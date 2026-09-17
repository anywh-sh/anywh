import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeAuthStatus } from "./authStatus.js";

test("parseClaudeAuthStatus: parses a logged-in status with email and subscription", () => {
  const status = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: "user@example.com", subscriptionType: "max" }));
  assert.deepEqual(status, { loggedIn: true, email: "user@example.com", subscriptionType: "max" });
});

test("parseClaudeAuthStatus: parses a logged-out status with no email/subscription fields", () => {
  const status = parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }));
  assert.deepEqual(status, { loggedIn: false });
});

test("parseClaudeAuthStatus: throws on invalid JSON — same failure mode runClaudeAuthStatus turns into a rejection", () => {
  assert.throws(() => parseClaudeAuthStatus("not json"));
});
