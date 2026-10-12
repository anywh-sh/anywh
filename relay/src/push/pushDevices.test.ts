import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidDeviceId,
  listDevices,
  parsePushDeviceBody,
  PUSH_DEVICE_TTL_MS,
  pruneExpired,
  removeDevice,
  removePushKeys,
  sanitizeLoaded,
  upsertDevice,
  type PushDevice,
} from "./pushDevices.js";

const valid = { gatewayUrl: "https://gw.example.test/push/v1/notify", pushKey: "k-1", data: { profileId: "p1" } };

test("parsePushDeviceBody accepts the contract's body and defaults data to an empty object", () => {
  assert.deepEqual(parsePushDeviceBody({ ...valid, label: "iPhone" }), { ok: true, value: { ...valid, label: "iPhone" } });
  const noData = parsePushDeviceBody({ gatewayUrl: valid.gatewayUrl, pushKey: "k" });
  assert.deepEqual(noData, { ok: true, value: { gatewayUrl: valid.gatewayUrl, pushKey: "k", data: {} } });
});

test("parsePushDeviceBody rejects what the contract forbids", () => {
  const bad: unknown[] = [
    null,
    [],
    "x",
    { ...valid, pushKey: "" },
    { ...valid, pushKey: "k".repeat(257) },
    { ...valid, gatewayUrl: "not a url" },
    { ...valid, gatewayUrl: "ftp://gw.example.test/x" },
    { ...valid, gatewayUrl: "http://gw.example.test/x" },
    { ...valid, gatewayUrl: "https://user:pw@gw.example.test/x" },
    { ...valid, gatewayUrl: `https://gw.example.test/${"a".repeat(2100)}` },
    { ...valid, label: "l".repeat(65) },
    { ...valid, label: 3 },
    { ...valid, data: [] },
    { ...valid, data: "x" },
    { ...valid, data: { blob: "x".repeat(600) } },
    { pushKey: "k" },
  ];
  for (const body of bad) assert.equal(parsePushDeviceBody(body).ok, false, JSON.stringify(body)?.slice(0, 80));
});

test("plain http is accepted only for a loopback gateway", () => {
  for (const host of ["127.0.0.1:9000", "localhost:9000", "[::1]:9000"]) {
    assert.equal(parsePushDeviceBody({ ...valid, gatewayUrl: `http://${host}/n` }).ok, true, host);
  }
  assert.equal(parsePushDeviceBody({ ...valid, gatewayUrl: "http://192.168.0.5/n" }).ok, false);
});

test("device ids are filenames-safe tokens, not arbitrary strings", () => {
  assert.equal(isValidDeviceId("3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"), true);
  for (const id of ["short", "has space here", "../../etc/passwd", "a".repeat(65), ""]) assert.equal(isValidDeviceId(id), false, id);
});

const device = (deviceId: string, over: Partial<PushDevice> = {}): PushDevice => ({ deviceId, ...valid, updatedAt: 1000, ...over });

test("upsertDevice replaces by deviceId and keeps the others", () => {
  const before = [device("device-aaa", { pushKey: "old" }), device("device-bbb")];
  const after = upsertDevice(before, "device-aaa", { ...valid, pushKey: "new" }, 5000);
  assert.equal(after.length, 2);
  assert.deepEqual(after.find((d) => d.deviceId === "device-aaa"), { deviceId: "device-aaa", ...valid, pushKey: "new", updatedAt: 5000 });
  assert.equal(before[0]?.pushKey, "old", "does not mutate its input");
});

test("two devices may hold the same key (one phone registered under a new deviceId); a dead key removes both", () => {
  const devices = [device("device-aaa", { pushKey: "dead" }), device("device-bbb", { pushKey: "dead" }), device("device-ccc", { pushKey: "alive" })];
  assert.deepEqual(removePushKeys(devices, ["dead"]).map((d) => d.deviceId), ["device-ccc"]);
  assert.deepEqual(removePushKeys(devices, []).length, 3);
  assert.deepEqual(removeDevice(devices, "device-ccc").length, 2);
});

test("pruneExpired drops entries not refreshed within the TTL, boundary included", () => {
  const now = 10 * PUSH_DEVICE_TTL_MS;
  const devices = [
    device("device-fresh", { updatedAt: now - PUSH_DEVICE_TTL_MS + 1 }),
    device("device-edge", { updatedAt: now - PUSH_DEVICE_TTL_MS }),
    device("device-old", { updatedAt: now - PUSH_DEVICE_TTL_MS - 1 }),
  ];
  assert.deepEqual(pruneExpired(devices, now).map((d) => d.deviceId), ["device-fresh"]);
});

test("the listing never reveals the push key or the gateway", () => {
  const listing = listDevices([device("device-aaa", { label: "iPhone", updatedAt: 42 }), device("device-bbb")]);
  assert.deepEqual(listing, [
    { deviceId: "device-aaa", label: "iPhone", lastSeenAt: 42 },
    { deviceId: "device-bbb", label: null, lastSeenAt: 1000 },
  ]);
  assert.ok(!JSON.stringify(listing).includes("k-1"));
});

test("sanitizeLoaded keeps well-formed entries and drops anything else", () => {
  const good = device("device-aaa");
  const loaded = sanitizeLoaded([good, null, { deviceId: "../x", ...valid, updatedAt: 1 }, { ...good, deviceId: "device-bad", gatewayUrl: "javascript:1" }, { ...good, deviceId: "device-nots", updatedAt: "x" }]);
  assert.deepEqual(loaded, [good]);
  assert.deepEqual(sanitizeLoaded({ not: "an array" }), []);
});
