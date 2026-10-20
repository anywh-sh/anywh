import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCodexDaemon, type CodexDaemonExitReason } from "./codexDaemon.js";
import type { AgentRuntimeDef, JsonRpcRequestSpec, TurnHost } from "../types.js";

// A real, executable Node script speaking real ndjson JSON-RPC over real
// stdio — not a mock of Codex's actual conversational behavior (that's
// relay/tests/fixtures/fake-codex.mjs's job, a later phase), just something
// genuine for this file's spawn/handshake/idle/kill mechanics to run
// against, the same spirit as detection.io.test.ts's `writeScript`.
interface FixtureBehavior {
  initFails?: boolean;
  ignoreSigterm?: boolean;
  crashAfterInitMs?: number;
  notifyAfterInit?: { method: string; params: unknown };
  pidFile?: string;
  /** Path the fixture writes the real `initialize` request's `params` to, as
   * JSON — the only way to assert on what `spawnCodexDaemon` actually sent,
   * since the handshake's own response never reaches the caller (it resolves
   * with a `CodexDaemon`, not the raw `initialize` result). */
  initializeParamsFile?: string;
  /** Path the fixture appends every JSON-RPC *response* it receives to
   * (messages with an `id` and no `method`) — proves the client's answer to
   * a server request was actually delivered. */
  responseLogFile?: string;
}

function writeFixture(dir: string, behavior: FixtureBehavior): string {
  const path = join(dir, "fake-codex");
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
const behavior = ${JSON.stringify(behavior)};
if (behavior.pidFile) fs.writeFileSync(behavior.pidFile, String(process.pid));
if (behavior.ignoreSigterm) process.on("SIGTERM", () => {});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      if (behavior.initializeParamsFile) fs.writeFileSync(behavior.initializeParamsFile, JSON.stringify(msg.params));
      if (behavior.initFails) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "init failed" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fixture" } });
        if (behavior.crashAfterInitMs) setTimeout(() => process.exit(1), behavior.crashAfterInitMs);
        if (behavior.notifyAfterInit) send({ jsonrpc: "2.0", method: behavior.notifyAfterInit.method, params: behavior.notifyAfterInit.params });
      }
      continue;
    }
    // A response to something the fixture sent (e.g. the client's answer to
    // a server request): log it, never echo it back.
    if (msg.method === undefined && msg.id !== undefined) {
      if (behavior.responseLogFile) fs.appendFileSync(behavior.responseLogFile, JSON.stringify(msg) + "\\n");
      continue;
    }
    // test/emit: params.notifications are pushed BEFORE the response, so by
    // the time request() resolves the daemon has already seen them.
    // params.serverRequest (optional) is pushed as a server->client request.
    if (msg.method === "test/emit") {
      for (const n of msg.params.notifications || []) send({ jsonrpc: "2.0", method: n.method, params: n.params });
      if (msg.params.serverRequest) send({ jsonrpc: "2.0", id: msg.params.serverRequest.id, method: msg.params.serverRequest.method, params: msg.params.serverRequest.params });
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      continue;
    }
    // test/slow: answers only after params.ms — a client request in flight.
    if (msg.method === "test/slow") {
      setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: {} }), msg.params.ms);
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { echoedMethod: msg.method, echoedParams: msg.params } });
  }
});
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

async function withTmpDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codex-daemon-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const noopHost: TurnHost = {
  requestApproval: () => Promise.reject(new Error("not exercised in this test")),
  requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
};

function fixtureDef(
  bin: string,
  overrides: Partial<Pick<AgentRuntimeDef, "identity">> = {},
  handleServerRequest: () => Promise<unknown> | undefined = () => undefined,
): AgentRuntimeDef {
  const startThread = (): JsonRpcRequestSpec => ({ method: "thread/start", params: {} });
  const startTurn = (): JsonRpcRequestSpec => ({ method: "turn/start", params: {} });
  return {
    identity: { id: "fixture", bin, env: { strip: [] }, projectInstructionsFile: "AGENTS.md", ...overrides.identity },
    capabilities: {
      presentChoice: "none",
      approvalPrompt: "native",
      rewindTurn: "none",
      replayHistory: "none",
      backgroundJobs: "none",
      thinking: "none",
      contextUsage: "none",
    },
    continuity: { kind: "cli-resume", resumeStyle: "capture" },
    models: { kind: "session-rpc" },
    auth: { kind: "session-rpc" },
    permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: true }] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: {
      kind: "jsonRpcDaemon",
      framing: "ndjson",
      thread: { start: startThread },
      turn: { start: startTurn, interrupt: (threadId, turnId) => ({ method: "turn/interrupt", params: { threadId, turnId } }) },
      mapNotification: () => [],
      handleServerRequest,
    },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

function waitForExit(onExitCalls: CodexDaemonExitReason[], timeoutMs = 2000): Promise<CodexDaemonExitReason> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (onExitCalls.length > 0) {
        resolve(onExitCalls[0]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`onExit was not called within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

// ---- handshake and request forwarding --------------------------------------

test("spawnCodexDaemon: resolves once initialize succeeds, and request() forwards method/params", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, {});
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: (reason) => onExitCalls.push(reason),
    });
    try {
      const result = await daemon.request("thread/start", { cwd: "/tmp" });
      assert.deepEqual(result, { echoedMethod: "thread/start", echoedParams: { cwd: "/tmp" } });
      assert.equal(daemon.exited, false);
    } finally {
      daemon.kill();
    }
    assert.deepEqual(onExitCalls, ["killed"]);
  });
});

test("spawnCodexDaemon: initialize declares experimentalApi — required for the granular approval workspace-write's turn/start sends", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { initializeParamsFile: join(dir, "init-params.json") });
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: (reason) => onExitCalls.push(reason),
    });
    try {
      const sent = JSON.parse(readFileSync(join(dir, "init-params.json"), "utf8")) as { capabilities: unknown };
      assert.deepEqual(sent.capabilities, { experimentalApi: true, requestAttestation: false });
    } finally {
      daemon.kill();
    }
  });
});

test("spawnCodexDaemon: rejects when initialize itself comes back as a JSON-RPC error", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { initFails: true });
    const onExitCalls: CodexDaemonExitReason[] = [];
    await assert.rejects(
      spawnCodexDaemon({ def: fixtureDef(bin), cwd: dir, host: noopHost, onNotification: () => {}, onExit: (reason) => onExitCalls.push(reason) }),
    );
    // No CodexDaemon ever existed, so onExit (which reports a live daemon's
    // fate) must never fire for this — the rejection itself is the report.
    assert.deepEqual(onExitCalls, []);
  });
});

test("spawnCodexDaemon: rejects instead of hanging when the binary doesn't exist", async () => {
  await assert.rejects(
    spawnCodexDaemon({
      def: fixtureDef("definitely-not-a-real-binary-xyz-anywh"),
      cwd: tmpdir(),
      host: noopHost,
      onNotification: () => {},
      onExit: () => {},
    }),
  );
});

test("spawnCodexDaemon: strips the def's own env.strip vars before spawning", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "fake-codex-env-check");
    writeFileSync(
      path,
      `#!/usr/bin/env node
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const leaked = process.env.FIXTURE_API_KEY ? "leaked" : "clean";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { leaked } }) + "\\n");
  }
});
`,
    );
    chmodSync(path, 0o755);
    process.env.FIXTURE_API_KEY = "should-never-reach-the-child";
    try {
      const daemon = await spawnCodexDaemon({
        def: fixtureDef(path, { identity: { id: "fixture", bin: path, env: { strip: ["FIXTURE_API_KEY"] }, projectInstructionsFile: "AGENTS.md" } }),
        cwd: dir,
        host: noopHost,
        onNotification: () => {},
        onExit: () => {},
      });
      try {
        assert.deepEqual(await daemon.request("thread/start", {}), { leaked: "clean" });
      } finally {
        daemon.kill();
      }
    } finally {
      delete process.env.FIXTURE_API_KEY;
    }
  });
});

// ---- crash, idle reaper, kill escalation ------------------------------------

test("spawnCodexDaemon: an unexpected exit after handshake reports 'crashed' and further request() rejects", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { crashAfterInitMs: 20 });
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: (reason) => onExitCalls.push(reason),
    });
    assert.equal(await waitForExit(onExitCalls), "crashed");
    assert.equal(daemon.exited, true);
    await assert.rejects(daemon.request("turn/start", {}), /already exited/);
  });
});

test("spawnCodexDaemon: the idle reaper kills the process and reports 'idle' after no request() activity", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, {});
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: (reason) => onExitCalls.push(reason),
      idleTimeoutMs: 30,
    });
    assert.equal(await waitForExit(onExitCalls), "idle");
    assert.equal(daemon.exited, true);
  });
});

test("spawnCodexDaemon: request() resets the idle timer, so activity keeps the daemon alive", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, {});
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: (reason) => onExitCalls.push(reason),
      idleTimeoutMs: 60,
    });
    try {
      // Two requests, 40ms apart — each individually well under the 60ms
      // idle window, so neither gap alone should trip the reaper.
      await daemon.request("turn/start", {});
      await new Promise((r) => setTimeout(r, 40));
      await daemon.request("turn/start", {});
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(daemon.exited, false);
      assert.deepEqual(onExitCalls, []);
    } finally {
      daemon.kill();
    }
  });
});

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`condition not met within ${timeoutMs}ms`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

// Manual stand-in for the idle reaper's timer: tests assert on whether one is
// armed and fire it by hand, so nothing here depends on wall-clock sleeps.
function fakeIdleTimers() {
  const armed = new Map<object, () => void>();
  return {
    timers: {
      set: (callback: () => void) => {
        const handle = {} as NodeJS.Timeout;
        armed.set(handle, callback);
        return handle;
      },
      clear: (handle: NodeJS.Timeout) => void armed.delete(handle),
    },
    armedCount: () => armed.size,
    fire: () => {
      for (const [handle, callback] of [...armed]) {
        armed.delete(handle);
        callback();
      }
    },
  };
}

const startedTurn = (id: string) => ({ method: "turn/started", params: { threadId: "t", turn: { id } } });
const completedTurn = (id: string) => ({ method: "turn/completed", params: { threadId: "t", turn: { id, status: "completed" } } });

async function spawnWithFakeTimers(dir: string, behavior: FixtureBehavior, handleServerRequest?: () => Promise<unknown> | undefined) {
  const bin = writeFixture(dir, behavior);
  const onExitCalls: CodexDaemonExitReason[] = [];
  const clock = fakeIdleTimers();
  const daemon = await spawnCodexDaemon({
    def: fixtureDef(bin, {}, handleServerRequest),
    cwd: dir,
    host: noopHost,
    onNotification: () => {},
    onExit: (reason) => onExitCalls.push(reason),
    idleTimers: clock.timers,
  });
  return { daemon, onExitCalls, clock };
}

test("idle reaper: an active turn pauses the timer until turn/completed re-arms it", async () => {
  await withTmpDir(async (dir) => {
    const { daemon, onExitCalls, clock } = await spawnWithFakeTimers(dir, {});
    try {
      assert.equal(clock.armedCount(), 1); // armed after the handshake
      await daemon.request("test/emit", { notifications: [startedTurn("a")] });
      assert.equal(clock.armedCount(), 0);
      await daemon.request("test/emit", { notifications: [completedTurn("a")] });
      assert.equal(clock.armedCount(), 1);
      clock.fire();
      assert.deepEqual(onExitCalls, ["idle"]);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: overlapping turns are tracked per id — completing one does not re-arm while another runs", async () => {
  await withTmpDir(async (dir) => {
    const { daemon, clock } = await spawnWithFakeTimers(dir, {});
    try {
      await daemon.request("test/emit", { notifications: [startedTurn("a"), startedTurn("b")] });
      await daemon.request("test/emit", { notifications: [completedTurn("a")] });
      assert.equal(clock.armedCount(), 0, "turn b is still running");
      await daemon.request("test/emit", { notifications: [completedTurn("b")] });
      assert.equal(clock.armedCount(), 1);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: a pending approval keeps the daemon alive; the answer is delivered and re-arms the timer", async () => {
  await withTmpDir(async (dir) => {
    const responseLogFile = join(dir, "responses.log");
    let answer: (value: unknown) => void = () => {};
    let requestSeen = false;
    const pending = new Promise<unknown>((resolve) => (answer = resolve));
    const { daemon, clock } = await spawnWithFakeTimers(dir, { responseLogFile }, () => {
      requestSeen = true;
      return pending;
    });
    try {
      await daemon.request("test/emit", {
        notifications: [startedTurn("a")],
        serverRequest: { id: 900, method: "item/commandExecution/requestApproval", params: { turnId: "a" } },
      });
      await waitFor(() => requestSeen);
      assert.equal(clock.armedCount(), 0);
      answer({ decision: "accept" });
      // The response must reach the fixture (not just be swallowed locally).
      await waitFor(() => existsSync(responseLogFile) && readFileSync(responseLogFile, "utf8").includes('"id":900'));
      const delivered = JSON.parse(readFileSync(responseLogFile, "utf8").trim().split("\n")[0]) as { id: number; result: unknown };
      assert.deepEqual(delivered, { jsonrpc: "2.0", id: 900, result: { decision: "accept" } });
      // Turn "a" is still active, so the timer stays paused until it completes.
      assert.equal(clock.armedCount(), 0);
      await daemon.request("test/emit", { notifications: [completedTurn("a")] });
      assert.equal(clock.armedCount(), 1);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: a rejected approval promise also releases the pause", async () => {
  await withTmpDir(async (dir) => {
    let requestSeen = false;
    const { daemon, clock } = await spawnWithFakeTimers(dir, {}, () => {
      requestSeen = true;
      return Promise.reject(new Error("host gave up"));
    });
    try {
      await daemon.request("test/emit", { notifications: [], serverRequest: { id: 901, method: "item/commandExecution/requestApproval", params: {} } });
      await waitFor(() => requestSeen);
      await waitFor(() => clock.armedCount() === 1);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: stop during a pending approval — turn/completed releases it even if the host promise never settles", async () => {
  await withTmpDir(async (dir) => {
    let requestSeen = false;
    const { daemon, clock } = await spawnWithFakeTimers(dir, {}, () => {
      requestSeen = true;
      return new Promise<unknown>(() => {}); // abandoned: never resolves or rejects
    });
    try {
      await daemon.request("test/emit", {
        notifications: [startedTurn("a")],
        serverRequest: { id: 902, method: "item/commandExecution/requestApproval", params: { turnId: "a" } },
      });
      await waitFor(() => requestSeen);
      assert.equal(clock.armedCount(), 0);
      // turn/interrupt -> turn/completed(interrupted) for the same turn.
      await daemon.request("test/emit", { notifications: [{ method: "turn/completed", params: { threadId: "t", turn: { id: "a", status: "interrupted" } } }] });
      assert.equal(clock.armedCount(), 1, "the stale approval must not block the reaper forever");
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: stop during a pending approval WITHOUT a turnId — any turn/completed of the same thread releases it", async () => {
  await withTmpDir(async (dir) => {
    let requestSeen = false;
    const { daemon, clock } = await spawnWithFakeTimers(dir, {}, () => {
      requestSeen = true;
      return new Promise<unknown>(() => {}); // abandoned
    });
    try {
      await daemon.request("test/emit", {
        notifications: [startedTurn("a")],
        serverRequest: { id: 903, method: "item/commandExecution/requestApproval", params: { threadId: "t" } },
      });
      await waitFor(() => requestSeen);
      assert.equal(clock.armedCount(), 0);
      await daemon.request("test/emit", { notifications: [completedTurn("a")] });
      assert.equal(clock.armedCount(), 1);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: id-less turn/started events pair one-to-one with id-less turn/completed events", async () => {
  await withTmpDir(async (dir) => {
    const { daemon, clock } = await spawnWithFakeTimers(dir, {});
    const bare = (method: string) => ({ method, params: { threadId: "t" } });
    try {
      await daemon.request("test/emit", { notifications: [bare("turn/started"), bare("turn/started")] });
      await daemon.request("test/emit", { notifications: [bare("turn/completed")] });
      assert.equal(clock.armedCount(), 0, "the second id-less turn is still running");
      await daemon.request("test/emit", { notifications: [bare("turn/completed")] });
      assert.equal(clock.armedCount(), 1);
    } finally {
      daemon.kill();
    }
  });
});

test("idle reaper: a client request still awaiting its response is never reaped under, and re-arms when it lands", async () => {
  await withTmpDir(async (dir) => {
    const { daemon, clock } = await spawnWithFakeTimers(dir, {});
    try {
      const slow = daemon.request("test/slow", { ms: 80 });
      assert.equal(clock.armedCount(), 0);
      await slow;
      assert.equal(clock.armedCount(), 1);
    } finally {
      daemon.kill();
    }
  });
});

test("kill(): reports 'killed' immediately, without waiting for the OS to reap the process", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, {});
    const onExitCalls: CodexDaemonExitReason[] = [];
    const daemon = await spawnCodexDaemon({ def: fixtureDef(bin), cwd: dir, host: noopHost, onNotification: () => {}, onExit: (r) => onExitCalls.push(r) });
    daemon.kill();
    assert.equal(daemon.exited, true);
    assert.deepEqual(onExitCalls, ["killed"]);
    daemon.kill(); // idempotent — a second call must not report a second exit
    assert.deepEqual(onExitCalls, ["killed"]);
  });
});

test("kill(): escalates to SIGKILL when the process ignores SIGTERM", async () => {
  await withTmpDir(async (dir) => {
    const pidFile = join(dir, "pid");
    const bin = writeFixture(dir, { ignoreSigterm: true, pidFile });
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: () => {},
      onExit: () => {},
      killGraceMs: 30,
    });
    // Written synchronously at the top of the fixture, before it even reads
    // stdin — by the time `initialize` has answered (spawnCodexDaemon
    // already resolved above), the file is guaranteed to exist.
    const pid = Number(readFileSync(pidFile, "utf8"));
    daemon.kill();
    // A process ignoring SIGTERM stays alive past the grace period on its
    // own; only a real SIGKILL (which it cannot ignore) actually ends it.
    await new Promise((r) => setTimeout(r, 150));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
});

// ---- inbound notifications and server->client requests ----------------------

test("spawnCodexDaemon: a notification the daemon pushes reaches onNotification verbatim", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { notifyAfterInit: { method: "item/started", params: { id: "abc" } } });
    const notifications: { method: string; params: unknown }[] = [];
    const daemon = await spawnCodexDaemon({
      def: fixtureDef(bin),
      cwd: dir,
      host: noopHost,
      onNotification: (method, params) => notifications.push({ method, params }),
      onExit: () => {},
    });
    try {
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(notifications, [{ method: "item/started", params: { id: "abc" } }]);
    } finally {
      daemon.kill();
    }
  });
});

test("spawnCodexDaemon: an inbound server request is routed through the def's handleServerRequest and the given TurnHost", async () => {
  await withTmpDir(async (dir) => {
    // A second stdin/stdout speaker: after the handshake, sends a real
    // server->client request and asserts on the response it gets back,
    // instead of only being driven by the daemon.
    const path = join(dir, "fake-codex-server-request");
    writeFileSync(
      path,
      `#!/usr/bin/env node
let buffer = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      send({ jsonrpc: "2.0", id: "srv-1", method: "item/tool/requestUserInput", params: { prompt: "?" } });
      continue;
    }
    if (msg.id === "srv-1") {
      send({ jsonrpc: "2.0", method: "test/serverRequestAnswered", params: msg });
    }
  }
});
`,
    );
    chmodSync(path, 0o755);

    const notifications: { method: string; params: unknown }[] = [];
    const host: TurnHost = {
      requestApproval: () => Promise.reject(new Error("not exercised in this test")),
      requestUserInput: (questions) => Promise.resolve(questions.map((q) => ({ questionId: q.id, values: [`answered: ${q.question}`] }))),
    };
    const def = fixtureDef(path);
    const daemon = await spawnCodexDaemon({
      def: {
        ...def,
        exec: {
          ...(def.exec as Extract<AgentRuntimeDef["exec"], { kind: "jsonRpcDaemon" }>),
          handleServerRequest: (method, params, turnHost) =>
            method === "item/tool/requestUserInput"
              ? turnHost.requestUserInput([{ id: "0", question: (params as { prompt: string }).prompt }])
              : undefined,
        },
      },
      cwd: dir,
      host,
      onNotification: (method, params) => notifications.push({ method, params }),
      onExit: () => {},
    });
    try {
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(notifications, [
        {
          method: "test/serverRequestAnswered",
          params: { jsonrpc: "2.0", id: "srv-1", result: [{ questionId: "0", values: ["answered: ?"] }] },
        },
      ]);
    } finally {
      daemon.kill();
    }
  });
});
