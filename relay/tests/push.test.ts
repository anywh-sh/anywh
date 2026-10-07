import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): a real relay, the fake
// `claude`, and a local HTTP server playing the push gateway — the third
// sanctioned external boundary, there because a real gateway needs a paid
// account and would notify a real phone. The registration routes, the
// registry on disk, presence over the real WebSocket, session events and the
// dispatcher are all the real thing.

interface GatewayRequest {
  body: { eventId: string; event: { kind: string; sessionId: string; title: string | null; preview: string | null }; devices: { pushKey: string; data: Record<string, unknown> }[] };
}

let server: TestServer;
let gateway: Server;
let gatewayUrl: string;
let requests: GatewayRequest[];
let answers: { status: number; body?: unknown }[];

before(async () => {
  server = await startTestServer();
  gateway = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      requests.push({ body: JSON.parse(raw) as GatewayRequest["body"] });
      const answer = answers.shift() ?? { status: 200, body: { rejected: [], failed: [] } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/push/v1/notify`;
});
after(async () => {
  await server.close();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
});
beforeEach(async () => {
  requests = [];
  answers = [];
  delete process.env.FAKE_CLAUDE_REPLY;
  // Every test starts with no registered device.
  const listed = (await (await fetch(url("/push/devices"))).json()) as { devices: { deviceId: string }[] };
  for (const d of listed.devices) await fetch(url(`/push/devices/${d.deviceId}`), { method: "DELETE" });
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const DEVICE = "3f2b1c9e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";

async function register(pushKey = "key-1", data: Record<string, unknown> = { profileId: "profile-on-device" }) {
  const response = await fetch(url(`/push/devices/${DEVICE}`), { method: "PUT", body: JSON.stringify({ gatewayUrl, pushKey, data }) });
  assert.equal(response.status, 204);
}

/** Explicit wait on the one condition that matters (see the skill's
 * "Determinism"): the gateway has seen `count` requests. */
async function gatewayRequests(count: number, timeoutMs = 8000): Promise<GatewayRequest[]> {
  const deadline = Date.now() + timeoutMs;
  while (requests.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} gateway request(s), saw ${requests.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return requests;
}

async function runTurn(sessionId: string, text: string, presence?: boolean) {
  const socket = await connectSession(server.port, sessionId);
  if (presence !== undefined) socket.send(JSON.stringify({ type: "presence", visible: presence }));
  sendUserMessage(socket, text);
  await collectUntil(socket, isTurnEnded);
  return socket;
}

test("a finished turn reaches the gateway with the session, a preview, and the device's own blob", async () => {
  await register();
  process.env.FAKE_CLAUDE_REPLY = "All **green**, nothing to fix.";
  (await runTurn("session-push-basic", "run the tests")).close();

  const [request] = await gatewayRequests(1);
  assert.equal(request?.body.event.kind, "turn_completed");
  assert.equal(request?.body.event.sessionId, "session-push-basic");
  assert.equal(request?.body.event.preview, "All green, nothing to fix.");
  assert.deepEqual(request?.body.devices, [{ pushKey: "key-1", data: { profileId: "profile-on-device" } }]);
  assert.match(request?.body.eventId ?? "", /^[0-9a-f-]{36}$/);
});

test("someone watching the session silences it; once they look away the next turn notifies", async () => {
  await register();
  process.env.FAKE_CLAUDE_REPLY = "first";
  const watcher = await runTurn("session-push-presence", "one", true);

  // Same socket: the claim is still live, so the second turn is silent too.
  process.env.FAKE_CLAUDE_REPLY = "second";
  sendUserMessage(watcher, "two");
  await collectUntil(watcher, isTurnEnded);

  watcher.send(JSON.stringify({ type: "presence", visible: false }));
  process.env.FAKE_CLAUDE_REPLY = "third";
  sendUserMessage(watcher, "three");
  await collectUntil(watcher, isTurnEnded);
  watcher.close();

  // The gateway saw exactly one request, and it is for the third turn: had
  // either earlier turn leaked, an earlier request would be first.
  const [only] = await gatewayRequests(1);
  assert.equal(only?.body.event.preview, "third");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(requests.length, 1);
});

test("a presence claim from one device silences the session for every other device too", async () => {
  await register();
  const watcher = await connectSession(server.port, "session-push-shared");
  watcher.send(JSON.stringify({ type: "presence", visible: true }));
  const other = await connectSession(server.port, "session-push-shared");
  process.env.FAKE_CLAUDE_REPLY = "quiet";
  sendUserMessage(other, "hi");
  await collectUntil(other, isTurnEnded);
  other.close();

  watcher.send(JSON.stringify({ type: "presence", visible: false }));
  process.env.FAKE_CLAUDE_REPLY = "loud";
  const again = await connectSession(server.port, "session-push-shared");
  sendUserMessage(again, "hi again");
  await collectUntil(again, isTurnEnded);
  watcher.close();
  again.close();

  const [only] = await gatewayRequests(1);
  assert.equal(only?.body.event.preview, "loud");
});

test("a watcher that disconnects without saying so stops silencing the session", async () => {
  await register();
  const watcher = await connectSession(server.port, "session-push-drop");
  watcher.send(JSON.stringify({ type: "presence", visible: true }));
  watcher.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  process.env.FAKE_CLAUDE_REPLY = "after the drop";
  (await runTurn("session-push-drop", "go")).close();
  assert.equal((await gatewayRequests(1))[0]?.body.event.preview, "after the drop");
});

test("a key the gateway rejects is dropped from the registry", async () => {
  await register("dead-key");
  answers.push({ status: 200, body: { rejected: ["dead-key"], failed: [] } });
  (await runTurn("session-push-rejected", "hello")).close();
  await gatewayRequests(1);

  const deadline = Date.now() + 5000;
  let devices: unknown[] = [{}];
  while (devices.length > 0 && Date.now() < deadline) {
    devices = ((await (await fetch(url("/push/devices"))).json()) as { devices: unknown[] }).devices;
    if (devices.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(devices, []);
});

test("a gateway that answers 503 is retried with the same event id", async () => {
  await register();
  answers.push({ status: 503 });
  (await runTurn("session-push-retry", "hello")).close();

  const seen = await gatewayRequests(2);
  assert.equal(seen[0]?.body.eventId, seen[1]?.body.eventId);
  assert.equal(seen[1]?.body.event.kind, "turn_completed");
});

test("a plan-mode question is announced as choice_required with the question as its preview", async () => {
  await register();
  const socket = await connectSession(server.port, "session-push-choice");
  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "plan" }));
  process.env.FAKE_CLAUDE_REPLY = "Plan.\n\n>>>QUESTION: Which database?\n- Postgres\n- SQLite\n>>>END";
  sendUserMessage(socket, "design it");
  await collectUntil(socket, (m) => m.type === "choice_prompt");
  socket.close();

  const kinds = (await gatewayRequests(2)).map((r) => r.body.event.kind).sort();
  assert.deepEqual(kinds, ["choice_required", "turn_completed"]);
  const choice = requests.find((r) => r.body.event.kind === "choice_required");
  assert.equal(choice?.body.event.preview, "Which database?");
});

test("a turn that fails to start is announced as turn_failed, with no error text", async () => {
  await register();
  const goneDir = join(server.homeDir, "moved-away-push");
  mkdirSync(goneDir, { recursive: true });
  const socket = await connectSession(server.port, "session-push-failed");
  socket.send(JSON.stringify({ type: "set_cwd", path: goneDir }));
  await collectUntil(socket, (m) => m.type === "cwd_state" && m.cwd === goneDir);
  rmSync(goneDir, { recursive: true, force: true });

  sendUserMessage(socket, "hello");
  await collectUntil(socket, (m) => m.type === "agent_event" && (m.event as { type?: string }).type === "error");
  socket.close();

  const [request] = await gatewayRequests(1);
  assert.equal(request?.body.event.kind, "turn_failed");
  assert.equal(request?.body.event.preview, null);
});

test("nothing is sent while no device is registered", async () => {
  (await runTurn("session-push-none", "hello")).close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests.length, 0);
});
