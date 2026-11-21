import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCron, dueDecision, MISSED_RUN_GRACE_MS, nextRunAfter } from "./botSchedule.js";

test("weekdays at 9:00 in a given time zone, skipping the weekend", () => {
  // Friday 2026-11-20 10:00 in São Paulo (UTC-3) → Monday 23rd 09:00 local = 12:00 UTC.
  const friday = Date.parse("2026-11-20T13:00:00Z");
  assert.equal(new Date(nextRunAfter("0 9 * * 1-5", friday, "America/Sao_Paulo")!).toISOString(), "2026-11-23T12:00:00.000Z");
});

test("a daily run across a daylight-saving change keeps its local hour", () => {
  // New York leaves DST on 2026-11-01: 9:00 local is 13:00 UTC before, 14:00 after.
  const before = Date.parse("2026-10-31T14:00:00Z");
  assert.equal(new Date(nextRunAfter("0 9 * * *", before, "America/New_York")!).toISOString(), "2026-11-01T14:00:00.000Z");
});

test("the next run is strictly after the given time", () => {
  const at = Date.parse("2026-11-21T10:00:00Z");
  assert.equal(nextRunAfter("0 10 * * *", at, "UTC"), Date.parse("2026-11-22T10:00:00Z"));
});

test("bad crons are refused with a reason, and never arm", () => {
  assert.equal(checkCron("0 9 * * 1-5").ok, true);
  const bad = checkCron("every hour");
  assert.equal(bad.ok, false);
  assert.equal(checkCron("0 9 * * * *").ok, false, "six fields are not five");
  assert.equal(nextRunAfter("nope", 0), undefined);
});

test("a run late by up to an hour still runs; later than that it is missed", () => {
  assert.equal(dueDecision(1000, 999), "wait");
  assert.equal(dueDecision(1000, 1000 + MISSED_RUN_GRACE_MS), "run");
  assert.equal(dueDecision(1000, 1001 + MISSED_RUN_GRACE_MS), "missed");
});
