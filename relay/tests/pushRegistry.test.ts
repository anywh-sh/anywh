import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): the push-address
// registry over HTTP, against the real relay and its real registry file.
// No agent process and no gateway involved — delivery has its own test.

let server: TestServer;
before(async () => {
  server = await startTestServer();
});
after(async () => {
  await server.close();
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const DEVICE = "3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const body = { gatewayUrl: "https://gw.example.test/push/v1/notify", pushKey: "secret-push-key", label: "iPhone", data: { profileId: "p1" } };
const put = (id: string, payload: unknown) => fetch(url(`/push/devices/${id}`), { method: "PUT", body: JSON.stringify(payload) });

test("a client registers, is listed without its key, re-registers in place, and unregisters idempotently", async () => {
  assert.equal((await put(DEVICE, body)).status, 204);

  const listed = (await (await fetch(url("/push/devices"))).json()) as { devices: { deviceId: string; label: string | null; lastSeenAt: number }[] };
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0]?.deviceId, DEVICE);
  assert.equal(listed.devices[0]?.label, "iPhone");
  assert.ok(!JSON.stringify(listed).includes("secret-push-key"), "the push key is a capability and must not be listable");

  assert.equal((await put(DEVICE, { ...body, label: "iPhone 2" })).status, 204);
  const again = (await (await fetch(url("/push/devices"))).json()) as { devices: { label: string }[] };
  assert.deepEqual(again.devices.map((d) => d.label), ["iPhone 2"]);

  assert.equal((await fetch(url(`/push/devices/${DEVICE}`), { method: "DELETE" })).status, 204);
  assert.equal((await fetch(url(`/push/devices/${DEVICE}`), { method: "DELETE" })).status, 204);
  const empty = (await (await fetch(url("/push/devices"))).json()) as { devices: unknown[] };
  assert.deepEqual(empty.devices, []);
});

test("it refuses what the contract forbids with a 400", async () => {
  assert.equal((await put(DEVICE, { ...body, gatewayUrl: "http://evil.example.test/x" })).status, 400);
  assert.equal((await put(DEVICE, { ...body, pushKey: "" })).status, 400);
  assert.equal((await put(DEVICE, "not an object")).status, 400);
  assert.equal((await fetch(url(`/push/devices/${DEVICE}`), { method: "PUT", body: "{nope" })).status, 400);
  assert.equal((await put("..%2F..%2Fetc%2Fpasswd", body)).status, 400);
  assert.equal((await put("short", body)).status, 400);
});

test("answers CORS preflight like the rest of the control surface", async () => {
  const response = await fetch(url(`/push/devices/${DEVICE}`), { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
