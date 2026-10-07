import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKOFF_BASE_MS, groupByGateway, interpretResponse, MAX_ATTEMPTS, nextDelayMs, parseRetryAfter } from "./delivery.js";
import type { PushDevice } from "./pushDevices.js";

const device = (deviceId: string, over: Partial<PushDevice> = {}): PushDevice => ({
  deviceId,
  gatewayUrl: "https://gw-a.example.test/n",
  pushKey: "k1",
  data: { profileId: "p1" },
  updatedAt: 0,
  ...over,
});

test("devices are grouped per gateway, one entry per distinct key and blob", () => {
  const groups = groupByGateway([
    device("device-aaa"),
    device("device-bbb", { pushKey: "k2" }),
    device("device-ccc", { gatewayUrl: "https://gw-b.example.test/n", pushKey: "k3" }),
    device("device-ddd"), // same key and blob as device-aaa: a reinstall
    device("device-eee", { data: { profileId: "other" } }), // same key, another profile: both are wanted
  ]);
  assert.deepEqual([...groups.keys()], ["https://gw-a.example.test/n", "https://gw-b.example.test/n"]);
  assert.deepEqual(groups.get("https://gw-a.example.test/n"), [
    { pushKey: "k1", data: { profileId: "p1" } },
    { pushKey: "k2", data: { profileId: "p1" } },
    { pushKey: "k1", data: { profileId: "other" } },
  ]);
});

test("a 200 reads the gateway's verdict per key; junk in the lists is ignored", () => {
  assert.deepEqual(interpretResponse(200, { rejected: ["a"], failed: ["b", 7, null] }, null, 0), { kind: "answered", rejected: ["a"], failed: ["b"] });
  assert.deepEqual(interpretResponse(200, {}, null, 0), { kind: "answered", rejected: [], failed: [] });
  assert.deepEqual(interpretResponse(200, undefined, null, 0), { kind: "answered", rejected: [], failed: [] });
  assert.deepEqual(interpretResponse(200, { rejected: "nope" }, null, 0), { kind: "answered", rejected: [], failed: [] });
});

test("throttling, server errors and no answer at all are retried; a 400 is not", () => {
  assert.deepEqual(interpretResponse(429, undefined, "7", 0), { kind: "retry", afterMs: 7000 });
  assert.deepEqual(interpretResponse(503, undefined, null, 0), { kind: "retry", afterMs: undefined });
  assert.deepEqual(interpretResponse(500, undefined, null, 0), { kind: "retry", afterMs: undefined });
  assert.deepEqual(interpretResponse(null, undefined, null, 0), { kind: "retry" });
  assert.deepEqual(interpretResponse(400, { error: "invalid_body" }, null, 0), { kind: "drop", reason: "gateway answered 400" });
  assert.equal(interpretResponse(404, undefined, null, 0).kind, "drop");
});

test("Retry-After accepts seconds or a date, and ignores the unusable", () => {
  assert.equal(parseRetryAfter("12", 0), 12_000);
  assert.equal(parseRetryAfter("0", 0), 0);
  assert.equal(parseRetryAfter(new Date(61_000).toUTCString(), 1000), 60_000);
  assert.equal(parseRetryAfter(new Date(0).toUTCString(), 5000), 0, "a date in the past means now");
  assert.equal(parseRetryAfter("soon", 0), undefined);
  assert.equal(parseRetryAfter(null, 0), undefined);
});

test("the backoff doubles from 2 s, is shortened by up to half at random, and bows to a longer Retry-After", () => {
  assert.equal(nextDelayMs(1, 0), BACKOFF_BASE_MS);
  assert.equal(nextDelayMs(2, 0), BACKOFF_BASE_MS * 2);
  assert.equal(nextDelayMs(4, 0), BACKOFF_BASE_MS * 8);
  assert.equal(nextDelayMs(1, 1), BACKOFF_BASE_MS / 2);
  assert.equal(nextDelayMs(1, 0, 10_000), 10_000);
  assert.equal(nextDelayMs(1, 0, 1_000), BACKOFF_BASE_MS, "a short Retry-After never makes it faster than the backoff");
  assert.equal(nextDelayMs(1, 0, 3_600_000), 60_000, "a huge Retry-After is capped");
});

test("five attempts add up to about half a minute of waiting at most", () => {
  let total = 0;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) total += nextDelayMs(attempt, 0);
  assert.equal(total, 30_000);
});
