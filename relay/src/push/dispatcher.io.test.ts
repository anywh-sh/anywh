import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { MAX_ATTEMPTS } from "./delivery.js";
import { PushDispatcher } from "./dispatcher.js";
import { PushStore } from "./pushStore.js";
import type { SessionPushEvent } from "../session/sessionManager.js";

// Boundary tier: a real PushStore on a tmpdir and a real HTTP server standing
// in for a gateway — the push-gateway fake the doctrine sanctions as a third
// external boundary (.anywh/skills/tests/SKILL.md). Only the clock is
// replaced, so a backoff can be stepped through instead of waited out.

interface Received {
  path: string;
  body: { v: number; eventId: string; event: Record<string, unknown>; devices: { pushKey: string; data: Record<string, unknown> }[] };
}

let gateway: Server;
let gatewayUrl: string;
let received: Received[];
let respond: (req: Received) => { status: number; body?: unknown; headers?: Record<string, string> };

before(async () => {
  gateway = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const entry: Received = { path: req.url ?? "", body: JSON.parse(raw) as Received["body"] };
      received.push(entry);
      const answer = respond(entry);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => gateway.close(() => resolve())));
beforeEach(() => {
  received = [];
  respond = () => ({ status: 200, body: { rejected: [], failed: [] } });
});

const event = (over: Partial<SessionPushEvent> = {}): SessionPushEvent => ({
  kind: "turn_completed",
  title: "Fix build",
  preview: "All green.",
  sessionId: "sess-1",
  ts: 1234,
  watched: false,
  ...over,
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "anywh-push-dispatch-"));
  const store = new PushStore(join(dir, "push.json"));
  const waiting: { run: () => void; delayMs: number }[] = [];
  const logs: string[] = [];
  let id = 0;
  const dispatcher = new PushDispatcher({
    store,
    schedule: (run, delayMs) => waiting.push({ run, delayMs }),
    random: () => 0,
    newEventId: () => `evt-${++id}`,
    log: (line) => logs.push(line),
  });
  const register = (deviceId: string, pushKey: string, over: { gateway?: string; data?: Record<string, unknown> } = {}) =>
    store.put(deviceId, { gatewayUrl: `${over.gateway ?? gatewayUrl}/n`, pushKey, data: over.data ?? { profileId: "p1" } });
  /** Lets the in-flight request (and anything it scheduled) settle. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const runNextRetry = async () => {
    const next = waiting.shift();
    assert.ok(next, "a retry should be waiting");
    next.run();
    await settle();
    return next.delayMs;
  };
  return { dir, store, dispatcher, register, settle, waiting, logs, runNextRetry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a notification reaches the gateway in the contract's shape, with each device's key and blob", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1", { data: { profileId: "p1" } });
    h.register("device-bbb", "k2", { data: { profileId: "p2" } });
    h.dispatcher.notify(event());
    await h.settle();

    assert.equal(received.length, 1, "one request per gateway, however many devices");
    assert.equal(received[0]?.path, "/n");
    assert.deepEqual(received[0]?.body, {
      v: 1,
      eventId: "evt-1",
      event: { kind: "turn_completed", sessionId: "sess-1", title: "Fix build", preview: "All green.", ts: 1234 },
      devices: [
        { pushKey: "k1", data: { profileId: "p1" } },
        { pushKey: "k2", data: { profileId: "p2" } },
      ],
    });
    assert.equal(h.waiting.length, 0);
  } finally {
    h.cleanup();
  }
});

test("nothing is sent when someone is watching the session, or when no device is registered", async () => {
  const h = harness();
  try {
    h.dispatcher.notify(event());
    h.register("device-aaa", "k1");
    h.dispatcher.notify(event({ watched: true }));
    await h.settle();
    assert.equal(received.length, 0);
  } finally {
    h.cleanup();
  }
});

test("devices behind different gateways get one request each", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1");
    h.register("device-bbb", "k2", { gateway: `${gatewayUrl}/other` });
    h.dispatcher.notify(event());
    await h.settle();
    assert.deepEqual(received.map((r) => r.path).sort(), ["/n", "/other/n"]);
  } finally {
    h.cleanup();
  }
});

test("a key the gateway rejects is forgotten for good, and the others are kept", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "dead");
    h.register("device-bbb", "alive");
    respond = () => ({ status: 200, body: { rejected: ["dead"], failed: [] } });
    h.dispatcher.notify(event());
    await h.settle();
    assert.deepEqual(h.store.all().map((d) => d.pushKey), ["alive"]);
    assert.equal(h.waiting.length, 0, "a rejection is final, nothing is retried");
  } finally {
    h.cleanup();
  }
});

test("only the keys that failed are retried, under the same event id, after a doubling backoff", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "ok");
    h.register("device-bbb", "flaky");
    let calls = 0;
    respond = () => (++calls <= 2 ? { status: 200, body: { rejected: [], failed: ["flaky"] } } : { status: 200, body: { rejected: [], failed: [] } });
    h.dispatcher.notify(event());
    await h.settle();

    const first = await h.runNextRetry();
    const second = await h.runNextRetry();
    assert.deepEqual([first, second], [2000, 4000]);
    assert.equal(received.length, 3);
    assert.deepEqual(received[1]?.body.devices.map((d) => d.pushKey), ["flaky"]);
    assert.deepEqual(received[2]?.body.devices.map((d) => d.pushKey), ["flaky"]);
    assert.deepEqual(received.map((r) => r.body.eventId), ["evt-1", "evt-1", "evt-1"]);
    assert.equal(h.waiting.length, 0, "the third attempt succeeded");
    assert.equal(h.store.all().length, 2, "a transient failure never removes a device");
  } finally {
    h.cleanup();
  }
});

test("a 503 repeats the whole request, and a 429's Retry-After lengthens the wait", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1");
    const answers = [{ status: 503 }, { status: 429, headers: { "retry-after": "30" } }, { status: 200, body: { rejected: [], failed: [] } }];
    respond = () => answers.shift() ?? { status: 200 };
    h.dispatcher.notify(event());
    await h.settle();
    assert.equal(await h.runNextRetry(), 2000);
    assert.equal(await h.runNextRetry(), 30_000);
    assert.equal(received.length, 3);
    assert.equal(h.waiting.length, 0);
  } finally {
    h.cleanup();
  }
});

test("a gateway that keeps failing is given up on after the attempt limit, without losing the device", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1");
    respond = () => ({ status: 503 });
    h.dispatcher.notify(event());
    await h.settle();
    for (let i = 1; i < MAX_ATTEMPTS; i++) await h.runNextRetry();
    assert.equal(received.length, MAX_ATTEMPTS);
    assert.equal(h.waiting.length, 0);
    assert.ok(h.logs.some((l) => l.includes("giving up")));
    assert.equal(h.store.all().length, 1);
  } finally {
    h.cleanup();
  }
});

test("a 400 is not retried", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1");
    respond = () => ({ status: 400, body: { error: "invalid_body" } });
    h.dispatcher.notify(event());
    await h.settle();
    assert.equal(received.length, 1);
    assert.equal(h.waiting.length, 0);
    assert.ok(h.logs.some((l) => l.includes("dropped")));
  } finally {
    h.cleanup();
  }
});

test("an unreachable gateway is retried, not forgotten", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1", { gateway: "http://127.0.0.1:1" });
    h.dispatcher.notify(event());
    await h.settle();
    assert.equal(h.waiting.length, 1);
    assert.equal(h.store.all().length, 1);
  } finally {
    h.cleanup();
  }
});

test("a redirect is not followed — the user's text only goes where it was registered", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "k1");
    respond = () => ({ status: 302, headers: { location: `${gatewayUrl}/elsewhere` } });
    h.dispatcher.notify(event());
    await h.settle();
    assert.deepEqual(received.map((r) => r.path), ["/n"]);
  } finally {
    h.cleanup();
  }
});

test("logs carry the event id, kind and gateway origin, never the notification's text", async () => {
  const h = harness();
  try {
    h.register("device-aaa", "secret-key");
    h.dispatcher.notify(event({ title: "TOP SECRET TITLE", preview: "TOP SECRET PREVIEW" }));
    await h.settle();
    const logged = h.logs.join("\n");
    assert.ok(logged.includes("evt-1") && logged.includes("turn_completed") && logged.includes(gatewayUrl));
    for (const secret of ["TOP SECRET", "secret-key"]) assert.ok(!logged.includes(secret), `leaked ${secret}`);
  } finally {
    h.cleanup();
  }
});
