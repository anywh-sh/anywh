// The session drivers hand a turn's plan usage to the capture, on the side:
// the fake `claude`/`codex app-server` (the sanctioned stand-ins) run as real
// children, behind a wrapper that adds the line a real CLI prints — a
// `rate_limit_event` before Claude's `result`, an `account/rateLimits/updated`
// push before Codex's `turn/completed` — and the chat events must come out
// exactly as without it.
//
// Everything that loads runtimes/executables.ts is imported dynamically,
// after AGENT_BIN is set (see defs/claude/driver.io.test.ts on why).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "../protocol/agent-event.js";
import { CLAUDE_EVENT_ALLOWED } from "../planUsage/fixtures.js";
import { PlanUsageCapture, type PlanUsageCaptureEvent } from "../planUsage/capture.js";
import type { AgentHost as AgentHostType } from "../agentHost/agentHost.js";
import type { HostClient as HostClientType } from "../agentHost/hostClient.js";
import type { SessionDriverHost } from "./sessionDriver.js";
import type { AgentRuntimeDef, RoomAgentSetup, TurnContext } from "./types.js";

const FIXTURES = resolve(import.meta.dirname, "../../tests/fixtures");
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.mjs");
const FAKE_CODEX = join(FIXTURES, "fake-codex-app-server.mjs");

const CODEX_PUSH = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1793340000 },
    secondary: null,
    planType: "plus",
    rateLimitReachedType: null,
  },
};

const dir = mkdtempSync(join(tmpdir(), "anywh-plan-usage-capture-"));

/** A wrapper around `target` that prints `inject` right before every
 * stdout line containing `match`, everything else passed through — unless
 * `inject` is null or `WRAPPER_PASS_THROUGH` is set in its environment,
 * which gives the bare fake's output to compare with. `delayMs` holds the matched line back a
 * little: the fake Codex completes a turn in the same chunk that accepts it,
 * faster than any real one, and the driver only waits for the completion
 * once the acceptance resolved. */
function injectingWrapper(name: string, target: string, match: string, inject: unknown, delayMs = 0): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const child = spawn(process.execPath, [${JSON.stringify(target)}, ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "inherit"] });
let queue = Promise.resolve();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const matched = line.includes(${JSON.stringify(match)});
  queue = queue.then(async () => {
    if (matched) await new Promise((done) => setTimeout(done, ${delayMs}));
    if (matched && ${inject !== null} && !process.env.WRAPPER_PASS_THROUGH) process.stdout.write(${JSON.stringify(JSON.stringify(inject))} + "\\n");
    process.stdout.write(line + "\\n");
  });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("close", (code, signal) => queue.then(() => process.exit(code ?? (signal ? 1 : 0))));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const CLAUDE_WITH_LIMITS = injectingWrapper("claude-with-limits", FAKE_CLAUDE, '"type":"result"', CLAUDE_EVENT_ALLOWED);
const CODEX_WITH_LIMITS = injectingWrapper(
  "codex-with-limits",
  FAKE_CODEX,
  '"method":"turn/completed"',
  {
    jsonrpc: "2.0",
    method: "account/rateLimits/updated",
    params: CODEX_PUSH,
  },
  20,
);
const CODEX_BARE = injectingWrapper("codex-bare", FAKE_CODEX, '"method":"turn/completed"', null, 20);

let ClaudeSessionDriver: typeof import("./defs/claude/driver.js").ClaudeSessionDriver;
let CodexSessionDriver: typeof import("./defs/codexDriver.js").CodexSessionDriver;
let HostSessionDriver: typeof import("./hostSessionDriver.js").HostSessionDriver;
let AgentHost: typeof AgentHostType;
let HostClient: typeof HostClientType;
let claudeRuntimeDef: AgentRuntimeDef;
let codexRuntimeDef: AgentRuntimeDef;

before(async () => {
  process.env.AGENT_BIN = CLAUDE_WITH_LIMITS;
  ({ ClaudeSessionDriver } = await import("./defs/claude/driver.js"));
  ({ CodexSessionDriver } = await import("./defs/codexDriver.js"));
  ({ HostSessionDriver } = await import("./hostSessionDriver.js"));
  ({ AgentHost } = await import("../agentHost/agentHost.js"));
  ({ HostClient } = await import("../agentHost/hostClient.js"));
  ({ claudeRuntimeDef } = await import("./defs/claude/index.js"));
  ({ codexRuntimeDef } = await import("./defs/codex.js"));
});

after(() => rmSync(dir, { recursive: true, force: true }));

const noopHost: SessionDriverHost = {
  presentChoice: () => {
    throw new Error("not exercised");
  },
  checkPermission: () => Promise.reject(new Error("not exercised")),
  requestApproval: () => Promise.reject(new Error("not exercised")),
  requestUserInput: () => Promise.reject(new Error("not exercised")),
};

const ctx = (cwd: string, prompt = "hello"): TurnContext => ({
  cwd,
  prompt,
  permissionModeId: "bypassPermissions",
});

function codexDef(bin: string): AgentRuntimeDef {
  return { ...codexRuntimeDef, identity: { ...codexRuntimeDef.identity, bin } };
}

/** A capture recording what it emits, and whether a turn was active each
 * time a chat event came out. */
function recordingCapture(): {
  capture: PlanUsageCapture;
  events: PlanUsageCaptureEvent[];
} {
  const capture = new PlanUsageCapture();
  const events: PlanUsageCaptureEvent[] = [];
  capture.subscribe((event) => events.push(event));
  return { capture, events };
}

/** Chat events with what differs from run to run (ids) taken out. */
function comparable(events: AgentEvent[]): unknown[] {
  return events
    .filter((event) => event.type !== "session_id")
    .map((event): unknown => JSON.parse(JSON.stringify(event, (key, value: unknown) => (key === "id" || key === "sessionId" ? "<id>" : value))));
}

test("a direct Claude turn hands its rate_limit_event to the capture and maps the chat exactly as without it", async () => {
  const { capture, events } = recordingCapture();
  const withLimits: AgentEvent[] = [];
  const activeDuringTurn: boolean[] = [];
  const driver = new ClaudeSessionDriver({
    host: noopHost,
    planUsage: capture,
  });
  await driver.sendTurn(ctx(dir), (event) => {
    withLimits.push(event);
    activeDuringTurn.push(capture.isTurnActive("claude"));
  });

  assert.deepEqual(
    events.map((event) => event.kind),
    ["turn_activity", "reading", "turn_activity"],
  );
  const reading = events[1];
  assert.ok(reading.kind === "reading");
  assert.equal(reading.reading.source, "turn");
  assert.deepEqual(
    reading.reading.windows.map((window) => [window.durationMins, window.usedPercent]),
    [
      [300, 63],
      [10080, 19],
    ],
  );
  assert.ok(activeDuringTurn.length > 0 && activeDuringTurn.every(Boolean), "the turn is active while it streams");
  assert.equal(capture.isTurnActive("claude"), false, "and no longer once it resolved");

  // The same turn without the rate_limit_event line.
  const bare: AgentEvent[] = [];
  process.env.WRAPPER_PASS_THROUGH = "1";
  try {
    await new ClaudeSessionDriver({
      host: noopHost,
      planUsage: new PlanUsageCapture(),
    }).sendTurn(ctx(dir), (event) => bare.push(event));
  } finally {
    delete process.env.WRAPPER_PASS_THROUGH;
  }
  assert.deepEqual(comparable(withLimits), comparable(bare));
});

test("a direct Codex turn hands the account push to the capture, never to the chat", async () => {
  const run = async (bin: string, capture: PlanUsageCapture): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const driver = new CodexSessionDriver(codexDef(bin), {
      host: noopHost,
      planUsage: capture,
    });
    try {
      await driver.sendTurn(ctx(dir), (event) => events.push(event));
    } finally {
      driver.dispose();
    }
    return events;
  };
  const { capture, events } = recordingCapture();
  const withLimits = await run(CODEX_WITH_LIMITS, capture);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["turn_activity", "codex_push", "turn_activity"],
  );
  const push = events[1];
  assert.ok(push.kind === "codex_push");
  assert.equal(push.bucket.planType, "plus");
  assert.deepEqual(push.bucket.windows, [
    {
      durationMins: 300,
      usedPercent: 42,
      resetsAt: 1793340000_000,
      limitId: "codex",
    },
  ]);

  const bare = await run(CODEX_BARE, new PlanUsageCapture());
  assert.ok(withLimits.length > 0);
  assert.deepEqual(comparable(withLimits), comparable(bare));
});

const workerSetup = (): RoomAgentSetup => ({
  role: "worker",
  instructions: "work",
  tools: [],
  bridgeServerName: "anywh-room",
  bridgeUrl: "http://127.0.0.1:9/room/x/y",
});

async function withHost(run: (h: { client: HostClientType }) => Promise<void>): Promise<void> {
  const hostDir = mkdtempSync(join(dir, "host-"));
  const home = join(hostDir, "home");
  mkdirSync(home);
  const host = await AgentHost.start({
    hostId: `puc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    dataDir: join(hostDir, "data"),
    socketPath: join(hostDir, "run", "host.sock"),
    agentBin: CLAUDE_WITH_LIMITS,
    codexDef: codexDef(CODEX_WITH_LIMITS),
    homeOverride: home,
    stopGraceMs: 2000,
    drainGraceMs: 500,
    turnSettleMs: 200,
  });
  const client = new HostClient({
    socketPath: host.socketPath,
    reconnectMinMs: 10,
    reconnectMaxMs: 50,
  });
  client.start();
  await client.waitUntilConnected();
  try {
    await run({ client });
  } finally {
    client.close();
    await host.close({ drainGraceMs: 200 });
  }
}

test("a room agent's turn in the agent host reaches the capture too, for Claude and for Codex", async () => {
  await withHost(async ({ client }) => {
    for (const [def, runtime, kind] of [
      [claudeRuntimeDef, "claude", "reading"],
      [codexRuntimeDef, "codex", "codex_push"],
    ] as const) {
      const { capture, events } = recordingCapture();
      const driver = new HostSessionDriver(def, {
        binding: {
          client,
          agentId: `${runtime}-1`,
          roomId: "room-a",
          setup: workerSetup,
        },
        planUsage: capture,
      });
      const chat: AgentEvent[] = [];
      const result = await driver.sendTurn(ctx(dir), (event) => chat.push(event));
      driver.dispose();
      assert.equal(result.stopped, false, runtime);
      assert.ok(
        chat.some((event) => event.type === "text"),
        `${runtime}: the chat still streams`,
      );
      assert.deepEqual(
        events.map((event) => event.kind),
        ["turn_activity", kind, "turn_activity"],
        runtime,
      );
      assert.ok(events.every((event) => event.kind !== "turn_activity" || event.runtime === runtime));
    }
  });
});
