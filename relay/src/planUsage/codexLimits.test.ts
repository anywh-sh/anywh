import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexRateLimitsError,
  codexLimitsPlanType,
  codexLimitsStatus,
  codexPlanWindows,
  mergeCodexRateLimits,
  parseCodexAccount,
  parseCodexLimitBucket,
  parseCodexRateLimitsRead,
  parseCodexRateLimitsUpdated,
} from "./codexLimits.js";
import {
  CODEX_ACCOUNT_READ_CHATGPT,
  CODEX_ERROR_API_KEY,
  CODEX_ERROR_SIGNED_OUT,
  CODEX_RATE_LIMITS_READ_FREE,
  CODEX_RATE_LIMITS_READ_PLUS,
  CODEX_RATE_LIMITS_UPDATED_EMPTY,
} from "./fixtures.js";

test("free plan: one 30-day window, exhausted", () => {
  const state = parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_FREE)!;
  assert.deepEqual(codexPlanWindows(state), [{ durationMins: 43200, usedPercent: 100, resetsAt: 1795025523_000, limitId: "codex" }]);
  assert.equal(codexLimitsStatus(state), "limited");
  assert.equal(codexLimitsPlanType(state), "free");
});

test("paid plan (synthetic): windows classified by duration, not by position, and snapped ±1", () => {
  const state = parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_PLUS)!;
  assert.deepEqual(
    codexPlanWindows(state).map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 12],
      [10080, 40],
    ],
  );
  assert.equal(codexLimitsStatus(state), "ok");
});

test("account ids, upsell and credits never leave the parser", () => {
  const serialized = JSON.stringify(parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_FREE));
  for (const leaked of ["redacted-account-id", "accountId", "rateLimitUpsell", "Try Plus", "out of Codex", "credits"]) {
    assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
  }
  assert.ok(!JSON.stringify(parseCodexAccount(CODEX_ACCOUNT_READ_CHATGPT)).includes("example.invalid"));
});

test("a push with every field null erases nothing and adds no bucket", () => {
  const state = parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_FREE)!;
  const update = parseCodexRateLimitsUpdated(CODEX_RATE_LIMITS_UPDATED_EMPTY)!;
  const merged = mergeCodexRateLimits(state, update);
  assert.deepEqual(Object.keys(merged.buckets), ["codex"]);
  assert.deepEqual(merged, state);
});

// The base has the 5h window in `secondary`; the push carries it in
// `primary`. Merging by slot would overwrite the weekly window.
test("a sparse push on the account bucket updates only the window it carries, matched by duration", () => {
  const state = parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_PLUS)!;
  const update = parseCodexLimitBucket({
    limitId: "codex",
    primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1793340001 },
    secondary: null,
    planType: null,
    rateLimitReachedType: null,
  })!;
  const merged = mergeCodexRateLimits(state, update);
  assert.deepEqual(
    codexPlanWindows(merged).map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 15],
      [10080, 40],
    ],
  );
  assert.equal(codexLimitsPlanType(merged), "plus");
  // The input state is left as it was.
  assert.equal(codexPlanWindows(state)[0]?.usedPercent, 12);
});

test("a push for a new bucket with a window becomes its own entry, outside the account windows", () => {
  const state = parseCodexRateLimitsRead(CODEX_RATE_LIMITS_READ_FREE)!;
  const merged = mergeCodexRateLimits(state, parseCodexRateLimitsUpdated({ rateLimits: { limitId: "premium", primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1793340000 } } })!);
  assert.deepEqual(Object.keys(merged.buckets).sort(), ["codex", "premium"]);
  assert.equal(codexPlanWindows(merged).length, 1);
});

test("limitId null is the account bucket; rateLimits is the fallback without rateLimitsByLimitId", () => {
  const state = parseCodexRateLimitsRead({
    rateLimits: { limitId: null, primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 1795025523 } },
  })!;
  assert.equal(codexPlanWindows(state)[0]?.usedPercent, 3);
  assert.equal(state.ordinaryUsageAllowed, null);
});

test("a window without a duration or a percentage is dropped", () => {
  const state = parseCodexRateLimitsRead({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 3, resetsAt: 1795025523 },
      secondary: { usedPercent: "7", windowDurationMins: 10080, resetsAt: 1795025523 },
    },
  })!;
  assert.deepEqual(state.buckets, {});
  assert.deepEqual(codexPlanWindows(state), []);
});

test("ordinaryUsageAllowed false is limited even below 100", () => {
  const state = parseCodexRateLimitsRead({ ...CODEX_RATE_LIMITS_READ_PLUS, ordinaryUsageAllowed: false })!;
  assert.equal(codexLimitsStatus(state), "limited");
});

test("non-object results are null", () => {
  assert.equal(parseCodexRateLimitsRead(null), null);
  assert.equal(parseCodexRateLimitsUpdated("x"), null);
  assert.equal(parseCodexLimitBucket([]), null);
});

test("account/read: signed out, API key, ChatGPT plan", () => {
  assert.deepEqual(parseCodexAccount({ account: null, requiresOpenaiAuth: true }), { kind: "signed_out" });
  assert.deepEqual(parseCodexAccount({ account: { type: "apiKey" } }), { kind: "api_key" });
  assert.deepEqual(parseCodexAccount(CODEX_ACCOUNT_READ_CHATGPT), { kind: "chatgpt", planType: "free" });
  assert.equal(parseCodexAccount({ account: { type: "other" } }), null);
  assert.equal(parseCodexAccount({}), null);
});

test("rate limit errors: no login vs API key vs anything else", () => {
  assert.equal(classifyCodexRateLimitsError(CODEX_ERROR_SIGNED_OUT), "signed_out");
  assert.equal(classifyCodexRateLimitsError(CODEX_ERROR_API_KEY), "no_subscription");
  assert.equal(classifyCodexRateLimitsError({ code: -32603, message: "internal error" }), null);
  assert.equal(classifyCodexRateLimitsError({ code: -32600, message: "invalid request" }), null);
  assert.equal(classifyCodexRateLimitsError(undefined), null);
});
