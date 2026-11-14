import { test } from "node:test";
import assert from "node:assert/strict";
import { kimiWebToken, parseKimiUsage, parseKimiUserInfo } from "./kimiLimits.js";

// Bodies as Kimi Code CLI 2.6.0's `kimi web` served them (personal fields
// replaced).
const USAGE = {
  code: 0,
  msg: "success",
  data: {
    kind: "ok",
    quota: {
      usages: {
        limit5h: { usedRatio: 1, resetAt: "2026-11-13T06:15:38Z" },
        monthTotal: { usedRatio: 0.1235, resetAt: "2026-12-14T00:00:00Z" },
        monthCode: { usedRatio: 0.1235, resetAt: "2026-12-14T00:00:00Z" },
      },
      extraUsage: null,
    },
  },
};

test("the quota becomes the 5h and month windows; a full one makes the account limited", () => {
  assert.deepEqual(parseKimiUsage(USAGE), {
    kind: "reading",
    status: "limited",
    windows: [
      { durationMins: 300, usedPercent: 100, resetsAt: Date.parse("2026-11-13T06:15:38Z") },
      { durationMins: 43200, usedPercent: 12.4, resetsAt: Date.parse("2026-12-14T00:00:00Z") },
    ],
  });
});

test("a 7-day window is read when the plan has one", () => {
  const withWeek = structuredClone(USAGE);
  (withWeek.data.quota.usages as Record<string, unknown>).limit7d = { usedRatio: 0.5, resetAt: "2026-11-18T00:00:00Z" };
  withWeek.data.quota.usages.limit5h.usedRatio = 0.2;
  const parsed = parseKimiUsage(withWeek);
  assert.equal(parsed.kind, "reading");
  if (parsed.kind !== "reading") return;
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.windows.map((window) => window.durationMins), [300, 10080, 43200]);
});

test("no login reads as signed_out; anything else unknown is unrecognized, never zero usage", () => {
  assert.deepEqual(parseKimiUsage({ code: 0, data: { kind: "error", message: 'No token for "kimi-code". Run /login to authenticate.' } }), { kind: "signed_out" });
  assert.deepEqual(parseKimiUsage({ code: 0, data: { kind: "error", message: "upstream timeout" } }), { kind: "unrecognized" });
  assert.deepEqual(parseKimiUsage({ code: 0, data: { kind: "ok", quota: { usages: {} } } }), { kind: "unrecognized" });
  assert.deepEqual(parseKimiUsage("nope"), { kind: "unrecognized" });
});

test("userinfo gives the plan chip and the id for the key, nothing else", () => {
  const account = parseKimiUserInfo({ code: 0, data: { kind: "ok", userInfo: { userId: "u-1", userLevelName: "Plus", email: "a@example.invalid", nickname: "n" } } });
  assert.deepEqual(account, { plan: { family: "plus", label: "Plus" }, userId: "u-1" });
  assert.deepEqual(parseKimiUserInfo({ data: { kind: "error", message: "No token" } }), {});
});

test("the bearer token comes from the banner's Token line", () => {
  assert.equal(kimiWebToken("  Local:    http://127.0.0.1:1/#token=abc\n\n  Token:    abc-123_x\n"), "abc-123_x");
  assert.equal(kimiWebToken("  Kimi server ready\n"), undefined);
  // A chunk that ends partway through the token: not the token yet.
  assert.equal(kimiWebToken("  Token:    abc-1"), undefined);
  assert.equal(kimiWebToken("  Token:    abc-1" + "23_x\r\n"), "abc-123_x");
});
