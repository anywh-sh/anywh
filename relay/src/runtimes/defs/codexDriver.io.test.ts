import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionDriver } from "./codexDriver.js";
import { codexRuntimeDef } from "./codex.js";
import { claudeRuntimeDef } from "./claude/index.js";
import type { AgentEvent } from "../../protocol/agent-event.js";
import type { TurnContext } from "../types.js";
import type { SessionDriverHost } from "../sessionDriver.js";

// Real child process speaking real ndjson JSON-RPC over real stdio — same
// spirit as codexDaemon.io.test.ts's own fixture, extended here to answer
// `thread/start`/`turn/start`/`turn/interrupt` and push the
// `item/completed`/`turn/completed` notifications a real turn produces, so
// CodexSessionDriver's turn-completion wait (this file's own reason to
// exist — see codexDriver.ts's header comment) gets exercised against a
// real process, not a fake `sendTurn` return value. Wired through the REAL
// `codexRuntimeDef` (only `identity.bin` swapped for the fixture path) —
// exercises the actual `thread.start`/`turn.start`/`turn.interrupt`/
// `mapNotification` this driver ships with, not a trivial stand-in.
interface FixtureBehavior {
  /** Text of the `item/completed` agentMessage sent before `turn/completed` —
   * omitted entirely when absent (no assistant text this turn). */
  reply?: string;
  turnStatus?: "completed" | "failed" | "interrupted";
  turnError?: string;
  /** Never sends `turn/completed` on its own — only `turn/interrupt`
   * triggers one (as `"interrupted"`), for exercising `stop()`. */
  holdTurnOpen?: boolean;
  completionDelayMs?: number;
  /** Every JSON-RPC method received, one per line, in arrival order — lets
   * a test assert `thread/start` only happens once across two turns on the
   * same thread. */
  logFile?: string;
  pidFile?: string;
}

function writeFixture(dir: string, behavior: FixtureBehavior): string {
  const path = join(dir, "fake-codex-app-server");
  const body = `#!/usr/bin/env node
const fs = require("node:fs");
const behavior = ${JSON.stringify(behavior)};
if (behavior.pidFile) fs.writeFileSync(behavior.pidFile, String(process.pid));
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function log(method) { if (behavior.logFile) fs.appendFileSync(behavior.logFile, method + "\\n"); }
let buffer = "";
let turnCounter = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log(msg.method);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fixture" } });
      continue;
    }
    if (msg.method === "thread/start") {
      send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } });
      continue;
    }
    if (msg.method === "turn/start") {
      turnCounter += 1;
      const turnId = "turn-" + turnCounter;
      send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (!behavior.holdTurnOpen) {
        setTimeout(() => {
          if (behavior.reply) {
            send({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", id: "m1", text: behavior.reply } } });
          }
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: turnId, status: behavior.turnStatus || "completed", error: behavior.turnError ? { message: behavior.turnError } : null } },
          });
        }, behavior.completionDelayMs || 5);
      }
      continue;
    }
    if (msg.method === "turn/interrupt") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, status: "interrupted", error: null } },
      });
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

async function withTmpDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-codex-driver-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const noopHost: SessionDriverHost = {
  presentChoice: () => {
    throw new Error("not exercised in this test");
  },
  checkPermission: () => Promise.reject(new Error("not exercised in this test")),
  requestApproval: () => Promise.reject(new Error("not exercised in this test")),
  requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
};

function fixtureDef(bin: string) {
  return { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin } };
}

function turnContext(cwd: string, overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd, prompt: "hello", permissionModeId: "workspace-write", ...overrides };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("sendTurn: thread/start then turn/start, waits for turn/completed (not turn/start's own response), maps the agentMessage, and learns the thread id", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { reply: "hi there" });
    const driver = new CodexSessionDriver(fixtureDef(bin), { host: noopHost });
    try {
      const events: AgentEvent[] = [];
      const result = await driver.sendTurn(turnContext(dir), (event) => events.push(event));
      assert.equal(result.stopped, false);
      assert.equal(result.lastAssistantText, "hi there");
      assert.ok(events.some((event) => event.type === "text" && event.text === "hi there"));
      assert.equal(driver.getSessionId(), "thread-1");
    } finally {
      driver.dispose();
    }
  });
});

test("sendTurn: a second turn on the same driver reuses the daemon and does NOT call thread/start again", async () => {
  await withTmpDir(async (dir) => {
    const logFile = join(dir, "log");
    writeFileSync(logFile, "");
    const bin = writeFixture(dir, { reply: "ok", logFile });
    const driver = new CodexSessionDriver(fixtureDef(bin), { host: noopHost });
    try {
      await driver.sendTurn(turnContext(dir), () => {});
      await driver.sendTurn(turnContext(dir), () => {});
      const methods = readFileSync(logFile, "utf8").trim().split("\n");
      assert.deepEqual(
        methods.filter((m) => m === "thread/start"),
        ["thread/start"],
        "thread/start must only be sent once across two turns on the same thread",
      );
      assert.deepEqual(
        methods.filter((m) => m === "turn/start"),
        ["turn/start", "turn/start"],
      );
    } finally {
      driver.dispose();
    }
  });
});

test("sendTurn: Turn.status \"failed\" rejects with the real TurnError message, not a generic one", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeFixture(dir, { turnStatus: "failed", turnError: "the model refused" });
    const driver = new CodexSessionDriver(fixtureDef(bin), { host: noopHost });
    try {
      await assert.rejects(driver.sendTurn(turnContext(dir), () => {}), /the model refused/);
    } finally {
      driver.dispose();
    }
  });
});

test("stop(): false when no turn is in flight", () => {
  const driver = new CodexSessionDriver(codexRuntimeDef, { host: noopHost });
  assert.equal(driver.stop(), false);
});

test("stop(): sends turn/interrupt with the real threadId/turnId, and the in-flight sendTurn resolves stopped:true from turn/completed", async () => {
  await withTmpDir(async (dir) => {
    const logFile = join(dir, "log");
    writeFileSync(logFile, "");
    const bin = writeFixture(dir, { holdTurnOpen: true, logFile });
    const driver = new CodexSessionDriver(fixtureDef(bin), { host: noopHost });
    try {
      const pending = driver.sendTurn(turnContext(dir), () => {});
      await waitFor(() => readFileSync(logFile, "utf8").includes("turn/start"));
      assert.equal(driver.stop(), true);
      const result = await pending;
      assert.equal(result.stopped, true);
      assert.ok(readFileSync(logFile, "utf8").includes("turn/interrupt"));
    } finally {
      driver.dispose();
    }
  });
});

test("getSessionId/setSessionId/resetSessionId: plain state, no daemon involved", () => {
  const driver = new CodexSessionDriver(codexRuntimeDef, { host: noopHost, initialSessionId: "thread-abc" });
  assert.equal(driver.getSessionId(), "thread-abc");
  driver.setSessionId("thread-xyz");
  assert.equal(driver.getSessionId(), "thread-xyz");
  driver.resetSessionId();
  assert.equal(driver.getSessionId(), undefined);
});

test("dispose(): kills the real daemon process", async () => {
  await withTmpDir(async (dir) => {
    const pidFile = join(dir, "pid");
    const bin = writeFixture(dir, { pidFile });
    const driver = new CodexSessionDriver(fixtureDef(bin), { host: noopHost });
    await driver.sendTurn(turnContext(dir), () => {});
    const pid = Number(readFileSync(pidFile, "utf8"));
    driver.dispose();
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
});

test("constructor: throws for a def whose exec plan isn't jsonRpcDaemon — never silently drives the wrong protocol", () => {
  assert.throws(() => new CodexSessionDriver(claudeRuntimeDef, { host: noopHost }), /no jsonRpcDaemon exec plan/);
});
