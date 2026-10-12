import assert from "node:assert/strict";
import { test } from "node:test";
import { isAnyoneLooking, leaseExpiry, PRESENCE_LEASE_MS } from "./presence.js";

test("a visible claim earns a lease of the configured length, a hidden one earns nothing", () => {
  assert.equal(leaseExpiry(true, 1000), 1000 + PRESENCE_LEASE_MS);
  assert.equal(leaseExpiry(true, 1000, 5000), 6000);
  assert.equal(leaseExpiry(false, 1000), null);
});

test("someone is looking exactly while a lease has not ended", () => {
  const now = 10_000;
  assert.equal(isAnyoneLooking([], now), false);
  assert.equal(isAnyoneLooking([now + 1], now), true);
  assert.equal(isAnyoneLooking([now], now), false, "a lease ending right now has ended");
  assert.equal(isAnyoneLooking([now - 1, now - 500], now), false);
});

test("one live lease among lapsed ones is enough", () => {
  assert.equal(isAnyoneLooking([1, 2, 99_999], 50_000), true);
});

test("a client that stops repeating its claim silences itself after one lease length", () => {
  const claimedAt = 0;
  const expiry = leaseExpiry(true, claimedAt) as number;
  assert.equal(isAnyoneLooking([expiry], claimedAt + PRESENCE_LEASE_MS - 1), true);
  assert.equal(isAnyoneLooking([expiry], claimedAt + PRESENCE_LEASE_MS), false);
});
