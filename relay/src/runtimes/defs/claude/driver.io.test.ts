import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentEvent } from "../../../protocol/agent-event.js";
import type { TurnContext } from "../../types.js";
import type { SessionDriverHost } from "../../sessionDriver.js";
import type { ClaudeSessionDriver as ClaudeSessionDriverType } from "./driver.js";
import type { transcriptPath as transcriptPathType } from "./transcriptReader.js";

// Real child process (the sanctioned mock boundary, .anywh/skills/tests/SKILL.md
// — fake-claude.mjs stands in for the `claude` binary, everything else here
// is real): characterizes ClaudeSessionDriver's spawn/map/stop/rewind
// mechanics BEFORE SharedSession is wired to use it (a later commit) — the
// bridge-registration half (choiceRegistration/permissionRegistration) is
// deliberately NOT exercised here, since that needs a real HTTP-mounted
// McpChoiceBridge/McpPermissionBridge the same way relay/tests/helpers/testServer.ts
// already stands one up; that integration proof comes from the 38
// relay/tests/*.test.ts files staying green once this driver is actually wired in.
//
// AGENT_BIN below MUST be set before `./driver.js` (which transitively
// imports runtimes/executables.ts) is ever loaded — that module resolves
// AGENT_BIN once, from the environment, as a top-level constant. A static
// `import` at the top of this file would already have evaluated it before
// any test body ran, env var or not: confirmed live writing this file,
// where a first draft with a static import spawned the REAL `claude`
// binary (a genuine, billed turn) instead of the fixture, despite setting
// `process.env.AGENT_BIN` inside a test — ESM hoists a static import's
// module evaluation ahead of any of THIS file's own top-level code,
// regardless of source order. `import type` below is erased at compile
// time (no runtime import), so it's exempt; the dynamic `import()` in
// `before()` is what actually loads the module, only after the env var is set.
const FAKE_AGENT_BIN = resolve(import.meta.dirname, "../../../../tests/fixtures/fake-claude.mjs");

let ClaudeSessionDriver: typeof ClaudeSessionDriverType;
let transcriptPath: typeof transcriptPathType;

before(async () => {
  process.env.AGENT_BIN = FAKE_AGENT_BIN;
  ({ ClaudeSessionDriver } = await import("./driver.js"));
  ({ transcriptPath } = await import("./transcriptReader.js"));
});

const noopHost: SessionDriverHost = {
  presentChoice: () => {
    throw new Error("not exercised in this test (no MCP bridge configured)");
  },
  checkPermission: () => Promise.reject(new Error("not exercised in this test")),
  requestApproval: () => Promise.reject(new Error("not exercised in this test")),
  requestUserInput: () => Promise.reject(new Error("not exercised in this test")),
};

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: process.cwd(), prompt: "hello", permissionModeId: "bypassPermissions", ...overrides };
}

test("sendTurn: without any bridge configured, no --mcp-config is built and the turn runs and maps events normally", async () => {
  process.env.FAKE_CLAUDE_REPLY = "hi there";
  try {
    const driver = new ClaudeSessionDriver({ host: noopHost });
    const events: AgentEvent[] = [];
    const result = await driver.sendTurn(turnContext(), (event) => events.push(event));
    assert.equal(result.stopped, false);
    assert.equal(result.lastAssistantText, "hi there");
    assert.ok(events.some((event) => event.type === "text" && event.text === "hi there"));
    assert.ok(events.some((event) => event.type === "session_id"));
  } finally {
    delete process.env.FAKE_CLAUDE_REPLY;
  }
});

test("getSessionId/setSessionId/resetSessionId delegate to the underlying ClaudeSession", () => {
  const driver = new ClaudeSessionDriver({ host: noopHost });
  assert.equal(driver.getSessionId(), undefined);
  driver.setSessionId("abc-123");
  assert.equal(driver.getSessionId(), "abc-123");
  driver.resetSessionId();
  assert.equal(driver.getSessionId(), undefined);
});

test("stop(): false when no turn is in flight — nothing to interrupt", () => {
  const driver = new ClaudeSessionDriver({ host: noopHost });
  assert.equal(driver.stop(), false);
});

test("dispose(): a no-op — a spawn-per-turn driver has nothing outliving a single turn", () => {
  const driver = new ClaudeSessionDriver({ host: noopHost });
  assert.doesNotThrow(() => driver.dispose());
});

test("rewind: rejects rather than touching disk when there is no sessionId to rewind from", async () => {
  const driver = new ClaudeSessionDriver({ host: noopHost });
  await assert.rejects(driver.rewind(1, process.cwd()), /no sessionId/);
});

test("rewind: truncates the real on-disk transcript, returns the new resumable id, and updates the driver's own sessionId", async () => {
  // Real transcript fixture on disk (same pattern as transcriptFork.test.ts)
  // rather than a fake-claude.mjs turn — the fake process only emits
  // stdout lines, it never writes the real CLI's .jsonl transcript file
  // that forkTruncatedTranscript operates on.
  const home = mkdtempSync(join(tmpdir(), "anywh-claude-driver-rewind-test-"));
  try {
    const sessionId = "s1";
    const path = transcriptPath(home, home, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        { type: "user", sessionId, uuid: "u1", message: { content: "question 1" } },
        { type: "assistant", sessionId, uuid: "a1", message: { content: [{ type: "text", text: "answer 1" }] } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    const driver = new ClaudeSessionDriver({ host: noopHost, homeOverride: home });
    driver.setSessionId(sessionId);
    const newSessionId = await driver.rewind(0, home);
    assert.notEqual(newSessionId, sessionId);
    assert.equal(driver.getSessionId(), newSessionId, "rewind updates the driver's own sessionId as a side effect, same as setSessionId would");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** argv of every fake-claude invocation made while `run` executes. */
async function recordSpawnArgv(run: () => Promise<void>): Promise<string[][]> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-claude-argv-test-"));
  const file = join(dir, "argv.jsonl");
  process.env.FAKE_CLAUDE_ARGV_FILE = file;
  try {
    await run();
    return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  } finally {
    delete process.env.FAKE_CLAUDE_ARGV_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
}

function mcpServerNames(argv: string[]): string[] {
  const index = argv.indexOf("--mcp-config");
  return index === -1 ? [] : Object.keys((JSON.parse(argv[index + 1]) as { mcpServers: object }).mcpServers).sort();
}

function homeWithUserMcp(): string {
  const home = mkdtempSync(join(tmpdir(), "anywh-claude-worker-home-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { posthog: { type: "http", url: "https://example.test/mcp" } } }));
  return home;
}

test("agent worker: spawns without user plugins/skills/hooks but with the user's MCP servers", async () => {
  const home = homeWithUserMcp();
  try {
    const driver = new ClaudeSessionDriver({ host: noopHost, homeOverride: home, agentWorker: true });
    const [argv] = await recordSpawnArgv(async () => {
      await driver.sendTurn(turnContext(), () => {});
    });
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "project,local");
    assert.deepEqual(mcpServerNames(argv), ["posthog"]);
    assert.ok(!argv.includes("--strict-mcp-config"), "account connectors must keep loading");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ordinary session: spawn flags are untouched even when the user has MCP servers", async () => {
  const home = homeWithUserMcp();
  try {
    const driver = new ClaudeSessionDriver({ host: noopHost, homeOverride: home });
    const [argv] = await recordSpawnArgv(async () => {
      await driver.sendTurn(turnContext(), () => {});
    });
    assert.ok(!argv.includes("--setting-sources"));
    assert.ok(!argv.includes("--mcp-config"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
