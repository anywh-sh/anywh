// The socket server and the relay's HostClient against each other over a
// real unix socket, with real event logs on disk. The test plays the agent
// by appending to the log directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventLog } from "./eventLog.js";
import { HostClient, START_OF_LOG, type AgentCursor } from "./hostClient.js";
import { AGENT_HOST_PROTOCOL_VERSION, HostError, type EventMessage, type HelloRefusedMessage } from "./protocol.js";
import { RELEASE_VERSION } from "./release.js";
import { AgentHostSocketServer } from "./socketServer.js";

async function waitFor(check: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Fixture {
  dir: string;
  socketPath: string;
  logs: Map<string, AgentEventLog>;
  server: AgentHostSocketServer;
  clients: HostClient[];
  cleanup(): Promise<void>;
}

async function fixture(options: { highWaterBytes?: number; replayChunkBytes?: number } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-hostsock-"));
  const socketPath = join(dir, "run", "host.sock");
  const logs = new Map<string, AgentEventLog>();
  const listen = (): Promise<AgentHostSocketServer> =>
    AgentHostSocketServer.listen({
      socketPath,
      hostId: "test",
      logFor: (agentId) => logs.get(agentId),
      handleRequest: (method) => {
        if (method === "echo") return Promise.resolve({ pong: true });
        if (method === "throw") throw new HostError("sync_failure", "thrown before any promise");
        return Promise.reject(new HostError("unknown_method", method));
      },
      ...options,
    });
  const f: Fixture = {
    dir,
    socketPath,
    logs,
    server: await listen(),
    clients: [],
    async cleanup() {
      for (const client of f.clients) client.close();
      await f.server.close();
      for (const log of logs.values()) log.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}

function newClient(f: Fixture, protocolVersion?: number): HostClient {
  const client = new HostClient({ socketPath: f.socketPath, clientName: "test", protocolVersion, reconnectMinMs: 10, reconnectMaxMs: 50 });
  f.clients.push(client);
  client.start();
  return client;
}

function collect(client: HostClient, agentId: string, from: AgentCursor = START_OF_LOG): { events: EventMessage[]; caughtUp: () => boolean; sub: ReturnType<HostClient["subscribe"]> } {
  const events: EventMessage[] = [];
  let caught = false;
  const sub = client.subscribe(agentId, from, {
    onEvent: (event) => events.push(event),
    onCaughtUp: () => {
      caught = true;
    },
  });
  return { events, caughtUp: () => caught, sub };
}

test("the socket is private: 0600 inside a 0700 directory, and a second host on it is refused", async () => {
  const f = await fixture();
  try {
    assert.equal(statSync(f.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, "run")).mode & 0o777, 0o700);
    await assert.rejects(
      AgentHostSocketServer.listen({ socketPath: f.socketPath, hostId: "x", logFor: () => undefined, handleRequest: () => Promise.resolve(null) }),
      /already listening/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a client from another protocol version is refused explicitly and gets nothing", async () => {
  const f = await fixture();
  try {
    f.logs.set("a1", AgentEventLog.open(join(f.dir, "logs", "a1")));
    f.logs.get("a1")!.append({ type: "assistant" });
    const client = newClient(f, AGENT_HOST_PROTOCOL_VERSION + 1);
    const refusals: HelloRefusedMessage[] = [];
    client.on("refused", (message) => refusals.push(message));
    const { events } = collect(client, "a1");
    await waitFor(() => refusals.length > 0, 5000, "refusal");
    assert.equal(refusals[0].reason, "protocol_version_mismatch");
    assert.equal(refusals[0].hostVersion, AGENT_HOST_PROTOCOL_VERSION);
    assert.equal(refusals[0].hostRelease, RELEASE_VERSION);
    assert.equal(client.status, "refused");
    await assert.rejects(client.request("echo"), /not connected/);
    assert.deepEqual(events, []);
  } finally {
    await f.cleanup();
  }
});

test("requests are answered, and a host error keeps its code", async () => {
  const f = await fixture();
  try {
    const client = newClient(f);
    await client.waitUntilConnected();
    assert.equal(client.hostRelease, RELEASE_VERSION);
    assert.deepEqual(await client.request("echo"), { pong: true });
    await assert.rejects(client.request("nope"), (error: Error & { code?: string }) => error.code === "unknown_method");
    // A handler that throws synchronously answers with an error, and the host keeps serving.
    await assert.rejects(client.request("throw"), (error: Error & { code?: string }) => error.code === "sync_failure");
    assert.deepEqual(await client.request("echo"), { pong: true });
  } finally {
    await f.cleanup();
  }
});

test("replay then live, with appends racing the replay, delivers every record once and in order", async () => {
  const f = await fixture({ replayChunkBytes: 2048 });
  try {
    const log = AgentEventLog.open(join(f.dir, "logs", "a1"));
    f.logs.set("a1", log);
    for (let i = 0; i < 300; i++) log.append({ type: "assistant", i, pad: "p".repeat(50) });
    const client = newClient(f);
    await client.waitUntilConnected();
    const { events, caughtUp } = collect(client, "a1");
    // Keep appending while the replay is still reading from disk.
    for (let i = 300; i < 600; i++) {
      log.append({ type: "assistant", i });
      if (i % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => events.length >= 600 && caughtUp(), 10_000, "600 events");
    for (let i = 600; i < 650; i++) log.append({ type: "assistant", i });
    await waitFor(() => events.length >= 650, 5000, "live events");
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 650 }, (_, i) => i),
    );
    assert.equal(events.at(-1)!.next, log.endOffset);
  } finally {
    await f.cleanup();
  }
});

test("a consumer that dies mid-stream is replaced by one resuming from its cursor: nothing lost, nothing twice", async () => {
  const f = await fixture();
  try {
    const log = AgentEventLog.open(join(f.dir, "logs", "a1"));
    f.logs.set("a1", log);
    for (let i = 0; i < 50; i++) log.append({ type: "assistant", i });

    const first = newClient(f);
    const a = collect(first, "a1");
    await waitFor(() => a.events.length >= 20, 5000, "first consumer");
    // Dies abruptly: the cursor is whatever it had processed.
    const cursorAtDeath = a.sub.cursor();
    first.close();
    const seenByFirst = a.events.filter((event) => event.seq <= cursorAtDeath.lastSeq);

    // The agent keeps going while nobody is connected.
    for (let i = 50; i < 120; i++) log.append({ type: "assistant", i });

    const second = newClient(f);
    const b = collect(second, "a1", cursorAtDeath);
    await waitFor(() => b.caughtUp(), 5000, "second consumer catch-up");
    for (let i = 120; i < 130; i++) log.append({ type: "assistant", i });
    await waitFor(() => (b.events.at(-1)?.seq ?? -1) === 129, 5000, "live tail");

    const union = [...seenByFirst, ...b.events].map((event) => event.seq);
    assert.deepEqual(
      union,
      Array.from({ length: 130 }, (_, i) => i),
    );
  } finally {
    await f.cleanup();
  }
});

test("the client reconnects by itself after the host restarts and continues from where it was", async () => {
  const f = await fixture();
  try {
    const log = AgentEventLog.open(join(f.dir, "logs", "a1"));
    f.logs.set("a1", log);
    for (let i = 0; i < 10; i++) log.append({ type: "assistant", i });
    const client = newClient(f);
    const { events } = collect(client, "a1");
    await waitFor(() => events.length === 10, 5000, "first 10");

    await f.server.close();
    await waitFor(() => client.status !== "connected", 5000, "disconnect");
    for (let i = 10; i < 25; i++) log.append({ type: "assistant", i });
    f.server = await AgentHostSocketServer.listen({
      socketPath: f.socketPath,
      hostId: "test",
      logFor: (agentId) => f.logs.get(agentId),
      handleRequest: () => Promise.resolve(null),
    });
    await waitFor(() => events.length >= 25, 5000, "events after reconnect");
    log.append({ type: "assistant", i: 25 });
    await waitFor(() => events.length >= 26, 5000, "live after reconnect");
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 26 }, (_, i) => i),
    );
  } finally {
    await f.cleanup();
  }
});

test("a stalled client cannot make the host buffer without bound, and gets everything once it reads again", async () => {
  const highWaterBytes = 64 * 1024;
  const replayChunkBytes = 16 * 1024;
  const f = await fixture({ highWaterBytes, replayChunkBytes });
  try {
    const log = AgentEventLog.open(join(f.dir, "logs", "a1"));
    f.logs.set("a1", log);

    // A raw socket client, so the test controls exactly when it reads.
    const socket = connect(f.socketPath);
    let inbound = "";
    const seqs: number[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      inbound += chunk;
      let nl: number;
      while ((nl = inbound.indexOf("\n")) >= 0) {
        const message = JSON.parse(inbound.slice(0, nl)) as { type: string; seq?: number };
        inbound = inbound.slice(nl + 1);
        if (message.type === "event") seqs.push(message.seq!);
      }
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ op: "hello", version: AGENT_HOST_PROTOCOL_VERSION })}\n`);
    socket.write(`${JSON.stringify({ op: "subscribe", id: 1, agentId: "a1", fromOffset: 0 })}\n`);
    await waitFor(() => f.server.connectionCount === 1, 5000, "connection");
    socket.pause();

    // ~8 MB of events while the client does not read.
    const record = { type: "assistant", pad: "q".repeat(4000) };
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
      log.append({ ...record, i });
      peak = Math.max(peak, ...f.server.bufferedBytes());
      if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    peak = Math.max(peak, ...f.server.bufferedBytes());
    const oneRecord = 4200;
    assert.ok(peak <= highWaterBytes + 2 * replayChunkBytes + oneRecord, `host buffered ${peak} bytes for a stalled client`);

    socket.resume();
    await waitFor(() => seqs.length >= 2000, 20_000, "all events after resuming");
    assert.deepEqual(
      seqs,
      Array.from({ length: 2000 }, (_, i) => i),
    );
    socket.destroy();
  } finally {
    await f.cleanup();
  }
});

test("subscribing to an unknown agent is an error the client reports", async () => {
  const f = await fixture();
  try {
    const client = newClient(f);
    await client.waitUntilConnected();
    const errors: string[] = [];
    client.subscribe("ghost", START_OF_LOG, { onEvent: () => {}, onError: (error) => errors.push(error.code) });
    await waitFor(() => errors.length > 0, 5000, "subscribe error");
    assert.deepEqual(errors, ["unknown_agent"]);
  } finally {
    await f.cleanup();
  }
});

test("FileCursorStore keeps cursors across instances, written atomically", async () => {
  const { FileCursorStore } = await import("./hostClient.js");
  const dir = mkdtempSync(join(tmpdir(), "anywh-cursors-"));
  try {
    const path = join(dir, "nested", "cursors.json");
    const store = new FileCursorStore(path);
    store.set("a1", { nextOffset: 120, lastSeq: 3 });
    store.flush();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(new FileCursorStore(path).get("a1"), { nextOffset: 120, lastSeq: 3 });
    store.delete("a1");
    assert.equal(new FileCursorStore(path).get("a1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacing a subscription mid-replay: records in flight for the old one never reach the new one", async () => {
  const f = await fixture({ replayChunkBytes: 4096 });
  try {
    const log = AgentEventLog.open(join(f.dir, "logs", "a1"));
    f.logs.set("a1", log);
    for (let i = 0; i < 5000; i++) log.append({ type: "assistant", i, pad: "r".repeat(60) });
    const client = newClient(f);
    await client.waitUntilConnected();
    const first: EventMessage[] = [];
    client.subscribe("a1", START_OF_LOG, { onEvent: (event) => first.push(event) });
    await waitFor(() => first.length >= 300, 5000, "first subscription under way");
    // Rewind: re-read from seq 100 with a new handler, while the old
    // subscription still has records on the wire.
    const rewind = { nextOffset: first[99].next, lastSeq: 99 };
    const second: EventMessage[] = [];
    let caughtUp = 0;
    client.subscribe("a1", rewind, {
      onEvent: (event) => second.push(event),
      onCaughtUp: () => caughtUp++,
    });
    await waitFor(() => caughtUp === 1, 10_000, "second subscription caught up");
    assert.equal(second[0].seq, 100);
    assert.deepEqual(
      second.map((event) => event.seq),
      Array.from({ length: 4900 }, (_, i) => i + 100),
    );
  } finally {
    await f.cleanup();
  }
});

test("a malformed subscribe is answered with an error carrying its id", async () => {
  const f = await fixture();
  try {
    const socket = connect(f.socketPath);
    const replies: { type: string; id?: number; ok?: boolean; error?: { code: string } }[] = [];
    let inbound = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      inbound += chunk;
      let nl: number;
      while ((nl = inbound.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(inbound.slice(0, nl)) as (typeof replies)[number]);
        inbound = inbound.slice(nl + 1);
      }
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${JSON.stringify({ op: "hello", version: AGENT_HOST_PROTOCOL_VERSION })}\n`);
    socket.write(`${JSON.stringify({ op: "subscribe", id: 7, agentId: "../etc", fromOffset: 0 })}\n`);
    await waitFor(() => replies.some((reply) => reply.type === "response"), 3000, "an answer");
    const reply = replies.find((r) => r.type === "response")!;
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, "bad_request");
    socket.destroy();
  } finally {
    await f.cleanup();
  }
});

test("a subscribe the host never answers is reported to the subscriber as a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-silent-"));
  const socketPath = join(dir, "run", "silent.sock");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "run"), { mode: 0o700 });
  // Completes the handshake, then answers nothing.
  const { createServer } = await import("node:net");
  const server = createServer((socket) => {
    socket.once("data", () => socket.write(`${JSON.stringify({ type: "hello_ok", version: AGENT_HOST_PROTOCOL_VERSION, hostPid: 1, hostId: "silent" })}\n`));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  const { chmodSync } = await import("node:fs");
  chmodSync(socketPath, 0o600);
  const client = new HostClient({ socketPath, requestTimeoutMs: 200, reconnectMinMs: 10, reconnectMaxMs: 50 });
  try {
    client.start();
    await client.waitUntilConnected();
    const errors: string[] = [];
    client.subscribe("a1", START_OF_LOG, { onEvent: () => {}, onError: (error) => errors.push(error.code) });
    await waitFor(() => errors.length > 0, 3000, "timeout reported");
    assert.deepEqual(errors, ["timeout"]);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileCursorStore drops entries of the wrong shape instead of trusting them", async () => {
  const { FileCursorStore } = await import("./hostClient.js");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "anywh-cursors-"));
  try {
    const path = join(dir, "cursors.json");
    writeFileSync(path, JSON.stringify({ bad1: { nextOffset: "x", lastSeq: 1 }, bad2: 5, bad3: { nextOffset: -1, lastSeq: 0 }, good: { nextOffset: 10, lastSeq: 2, incarnation: "i" } }));
    const store = new FileCursorStore(path);
    assert.equal(store.get("bad1"), undefined);
    assert.equal(store.get("bad2"), undefined);
    assert.equal(store.get("bad3"), undefined);
    assert.deepEqual(store.get("good"), { nextOffset: 10, lastSeq: 2, incarnation: "i" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
