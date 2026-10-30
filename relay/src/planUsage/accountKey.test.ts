import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_KEY_HEX_LENGTH, accountKeyForLog, claudeAccountKey, codexAccountKey, deriveAccountKey } from "./accountKey.js";

const SALT = new Uint8Array(32).fill(7);
const OTHER_SALT = new Uint8Array(32).fill(9);
const ACCOUNT = "4f7c0a52-0000-4000-8000-00000000aaaa";
const ORG = "9b1d2e33-0000-4000-8000-00000000bbbb";
const OTHER_ORG = "9b1d2e33-0000-4000-8000-00000000cccc";

test("a key is 16 lowercase hex, deterministic for the same salt and parts", () => {
  const key = deriveAccountKey(SALT, "claude", "claude_account_org", ACCOUNT, ORG);
  assert.match(key ?? "", new RegExp(`^[0-9a-f]{${ACCOUNT_KEY_HEX_LENGTH}}$`));
  assert.equal(deriveAccountKey(SALT, "claude", "claude_account_org", ACCOUNT, ORG), key);
});

test("parts are normalized: case and surrounding space don't change the key", () => {
  assert.equal(
    deriveAccountKey(SALT, "codex", "codex_email_plan", "  Someone@Example.INVALID ", "Plus"),
    deriveAccountKey(SALT, "codex", "codex_email_plan", "someone@example.invalid", "plus"),
  );
});

test("salt, runtime, kind and every part change the key", () => {
  const base = deriveAccountKey(SALT, "claude", "claude_account_org", ACCOUNT, ORG);
  const variants = [
    deriveAccountKey(OTHER_SALT, "claude", "claude_account_org", ACCOUNT, ORG),
    deriveAccountKey(SALT, "codex", "claude_account_org", ACCOUNT, ORG),
    deriveAccountKey(SALT, "claude", "claude_email_org", ACCOUNT, ORG),
    deriveAccountKey(SALT, "claude", "claude_account_org", ACCOUNT, OTHER_ORG),
    deriveAccountKey(SALT, "claude", "claude_account_org", ORG, ACCOUNT),
  ];
  for (const variant of variants) assert.notEqual(variant, base);
});

test("part boundaries are unambiguous", () => {
  assert.notEqual(deriveAccountKey(SALT, "codex", "codex_email_plan", "ab", "c"), deriveAccountKey(SALT, "codex", "codex_email_plan", "a", "bc"));
});

test("an incomplete pair has no key: never merged on a guess", () => {
  for (const [a, b] of [
    [ACCOUNT, null],
    [undefined, ORG],
    ["", ORG],
    ["   ", ORG],
    [ACCOUNT, 42],
  ] as const) {
    assert.equal(deriveAccountKey(SALT, "claude", "claude_account_org", a, b), undefined);
  }
});

test("claude: the file identity wins when it agrees with auth status", () => {
  const file = { accountUuid: ACCOUNT, organizationUuid: ORG };
  const expected = deriveAccountKey(SALT, "claude", "claude_account_org", ACCOUNT, ORG);
  assert.equal(claudeAccountKey(SALT, file, { loggedIn: true, email: "a@example.invalid", orgId: ORG.toUpperCase() }), expected);
  // No orgId in the status to contradict it: the file stands.
  assert.equal(claudeAccountKey(SALT, file, { loggedIn: true }), expected);
});

test("claude: auth status is the authority — a disagreeing file is dropped for (email, orgId)", () => {
  const file = { accountUuid: ACCOUNT, organizationUuid: ORG };
  const status = { loggedIn: true, email: "a@example.invalid", orgId: OTHER_ORG };
  assert.equal(claudeAccountKey(SALT, file, status), deriveAccountKey(SALT, "claude", "claude_email_org", "a@example.invalid", OTHER_ORG));
});

test("claude: an incomplete file falls back to auth status; nothing usable is no key", () => {
  const status = { email: "a@example.invalid", orgId: ORG };
  const fallback = deriveAccountKey(SALT, "claude", "claude_email_org", "a@example.invalid", ORG);
  assert.equal(claudeAccountKey(SALT, { accountUuid: null, organizationUuid: ORG }, status), fallback);
  assert.equal(claudeAccountKey(SALT, undefined, status), fallback);
  assert.equal(claudeAccountKey(SALT, undefined, { loggedIn: false }), undefined);
  assert.equal(claudeAccountKey(SALT, undefined, null), undefined);
});

test("codex: (email, planType) from account/read; no key for API key, signed out or missing plan", () => {
  const result = { account: { type: "chatgpt", email: "a@example.invalid", planType: "plus" }, requiresOpenaiAuth: true };
  assert.equal(codexAccountKey(SALT, result), deriveAccountKey(SALT, "codex", "codex_email_plan", "a@example.invalid", "plus"));
  // Same e-mail, another plan (personal Plus vs Team): distinct accounts.
  assert.notEqual(codexAccountKey(SALT, result), codexAccountKey(SALT, { account: { ...result.account, planType: "team" } }));
  assert.equal(codexAccountKey(SALT, { account: { type: "apiKey" } }), undefined);
  assert.equal(codexAccountKey(SALT, { account: null }), undefined);
  assert.equal(codexAccountKey(SALT, { account: { type: "chatgpt", email: "a@example.invalid", planType: null } }), undefined);
  assert.equal(codexAccountKey(SALT, "x"), undefined);
});

test("neither the key nor its log form carries the parts", () => {
  const key = codexAccountKey(SALT, { account: { type: "chatgpt", email: "a@example.invalid", planType: "plus" } })!;
  assert.ok(!key.includes("example"));
  assert.equal(accountKeyForLog(key), `${key.slice(0, 4)}…`);
  assert.equal(accountKeyForLog(undefined), "none");
});
