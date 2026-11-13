import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpSessionDriver } from "./acpDriver.js";
import { ACP_HISTORY_METHOD, acpInitialize, acpInterrupt, acpThreadResume, acpThreadStart, acpTurnStart, answerAcpApproval, type AcpPermissionParams } from "./acp.js";
import { acpNotificationMapping } from "../streams/acpSessionUpdate.js";
import type { AgentEvent } from "../../protocol/agent-event.js";
import type { AgentRuntimeDef, ApprovalRequest, TurnContext } from "../types.js";
import type { SessionDriverHost } from "../sessionDriver.js";

// A real child process speaking ACP over real stdio
// (`tests/fixtures/fake-acp-agent.mjs`, shapes recorded from Kimi Code CLI
// 2.6.0) — what is under test is the engine: one process across turns,
// session attach on a fresh process, settings sent only when they change,
// a turn that ends on `session/prompt`'s answer, a stop that releases an
// open permission request. Proves the wiring, not Kimi's behaviour.
const FAKE_AGENT = resolve(import.meta.dirname, "../../../tests/fixtures/fake-acp-agent.mjs");

const mapping = acpNotificationMapping({ logTag: "fake" });

function fixtureDef(): AgentRuntimeDef {
  return {
    identity: { id: "fake-acp", bin: FAKE_AGENT, env: { strip: ["FAKE_ACP_API_KEY"] }, projectInstructionsFile: "AGENTS.md" },
    capabilities: { presentChoice: "none", approvalPrompt: "native", rewindTurn: "none", replayHistory: "native", backgroundJobs: "none", thinking: "native", contextUsage: "native" },
    continuity: { kind: "cli-resume", resumeStyle: "capture" },
    models: { kind: "static", catalog: { options: [] } },
    auth: { kind: "none" },
    permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "x", settings: undefined, pausesForApproval: true }] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: {
      kind: "jsonRpcDaemon",
      protocol: "acp",
      args: ["acp"],
      initialize: acpInitialize,
      framing: "ndjson",
      thread: { start: acpThreadStart, resume: acpThreadResume },
      turn: { start: acpTurnStart, interrupt: acpInterrupt },
      replayHistoryMethod: ACP_HISTORY_METHOD,
      configureSession: (ctx, sessionId) => [
        { method: "session/set_mode", params: { sessionId, modeId: ctx.permissionModeId } },
        ...(ctx.modelId ? [{ method: "session/set_config_option", params: { sessionId, configId: "model", value: ctx.modelId } }] : []),
        ...(ctx.effortId ? [{ method: "session/set_config_option", params: { sessionId, configId: "thinking", value: ctx.effortId } }] : []),
      ],
      ...mapping,
      handleServerRequest: (method, params, host) => (method === "session/request_permission" ? answerAcpApproval(params as AcpPermissionParams, host) : undefined),
    },
    portability: { authoredPaths: [".fake/skills"], mcp: { kind: "none" } },
  };
}

interface Harness {
  readonly dir: string;
  readonly approvals: ApprovalRequest[];
  /** What the next approval answers; a function to hold it open. */
  answer: string | (() => Promise<string>);
  readonly host: SessionDriverHost;
  received(): { method?: string; params?: Record<string, unknown> }[];
  cleanup(): void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "acp-driver-"));
  process.env.FAKE_ACP_STATE = join(dir, "state.json");
  process.env.FAKE_ACP_LOG = join(dir, "log.jsonl");
  const h: Harness = {
    dir,
    approvals: [],
    answer: "accept",
    host: {
      requestApproval: (request: ApprovalRequest) => {
        h.approvals.push(request);
        return typeof h.answer === "string" ? Promise.resolve(h.answer) : h.answer();
      },
      requestUserInput: () => Promise.resolve("deferred" as const),
      presentChoice: () => Promise.reject(new Error("not used")),
      checkPermission: () => Promise.reject(new Error("not used")),
    } as unknown as SessionDriverHost,
    received: () =>
      readFileSync(join(dir, "log.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return h;
}

function ctx(dir: string, prompt: string, extra: Partial<TurnContext> = {}): TurnContext {
  return { cwd: dir, prompt, permissionModeId: "default", ...extra };
}

async function turn(driver: AcpSessionDriver, context: TurnContext): Promise<{ events: AgentEvent[]; result: Awaited<ReturnType<AcpSessionDriver["sendTurn"]>> }> {
  const events: AgentEvent[] = [];
  const result = await driver.sendTurn(context, (event) => events.push(event));
  return { events, result };
}

test("a turn creates the session, streams the reply and ends on session/prompt's answer", async () => {
  const h = harness();
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host });
  try {
    const { events, result } = await turn(driver, ctx(h.dir, "hello"));
    assert.equal(driver.getSessionId(), "session_1");
    assert.equal(result.stopped, false);
    assert.equal(result.lastAssistantText, "echo: hello");
    assert.deepEqual(result.contextUsage, { model: "m1", contextWindowSize: 1000, usedTokens: 100 });
    const kinds = events.map((event) => event.type);
    assert.deepEqual(kinds, ["usage", "thinking_started", "thinking_delta", "thinking", "text_delta", "text_delta", "text"]);
  } finally {
    driver.dispose();
    h.cleanup();
  }
});

test("settings are sent before the prompt, and only again once one of them changes", async () => {
  const h = harness();
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host });
  try {
    await turn(driver, ctx(h.dir, "one", { modelId: "m2", effortId: "on" }));
    await turn(driver, ctx(h.dir, "two", { modelId: "m2", effortId: "on" }));
    await turn(driver, ctx(h.dir, "three", { modelId: "m2", effortId: "high", permissionModeId: "yolo" }));
    const sent = h.received().filter((message) => message.method === "session/set_mode" || message.method === "session/set_config_option" || message.method === "session/prompt");
    const describe = sent.map((message) => (message.method === "session/prompt" ? "prompt" : `${message.method === "session/set_mode" ? "mode" : String(message.params?.configId)}=${String(message.params?.modeId ?? message.params?.value)}`));
    // Turn two sends nothing new; turn three changes the mode, so the model
    // and the level after it go again too.
    assert.deepEqual(describe, ["mode=default", "model=m2", "thinking=on", "prompt", "prompt", "mode=yolo", "model=m2", "thinking=high", "prompt"]);
    assert.equal(h.received().filter((message) => message.method === "initialize").length, 1, "one process serves every turn");
  } finally {
    driver.dispose();
    h.cleanup();
  }
});

test("a permission request is answered with the agent's own option, and the call it names shows its input", async () => {
  const h = harness();
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host });
  try {
    const { events } = await turn(driver, ctx(h.dir, "[[tool]]"));
    assert.equal(h.approvals.length, 1);
    assert.equal(h.approvals[0].detail?.text, "ls", "the input from the earlier update is added back to the request");
    assert.deepEqual(
      h.approvals[0].availableDecisions.map((decision) => decision.id),
      ["accept", "acceptForSession", "decline"],
    );
    const answer = h.received().find((message) => message.method === undefined && (message as { result?: { outcome?: unknown } }).result?.outcome);
    assert.deepEqual((answer as { result: unknown }).result, { outcome: { outcome: "selected", optionId: "approve_once" } });
    const ended = events.find((event) => event.type === "tool_ended");
    assert.deepEqual(ended, { type: "tool_ended", toolUseId: "0:tool_bash", content: "file.txt\n", isError: false, outcome: { kind: "terminal", output: "file.txt\n" } });
  } finally {
    driver.dispose();
    h.cleanup();
  }
});

test("stop cancels the turn and releases the permission request still open", async () => {
  const h = harness();
  let release: (() => void) | undefined;
  h.answer = () => new Promise<string>((resolveAnswer) => (release = () => resolveAnswer("accept")));
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host });
  try {
    const pending = turn(driver, ctx(h.dir, "[[hang]]"));
    while (h.approvals.length === 0) await new Promise((r) => setTimeout(r, 10));
    assert.equal(driver.stop(), true);
    const { result } = await pending;
    assert.equal(result.stopped, true);
    assert.ok(h.received().some((message) => message.method === "session/cancel"));
    // The human never answered; the session survives for the next turn.
    release?.();
    const next = await turn(driver, ctx(h.dir, "again"));
    assert.equal(next.result.lastAssistantText, "echo: again");
    assert.equal(driver.stop(), false, "nothing left to stop");
  } finally {
    driver.dispose();
    h.cleanup();
  }
});

test("a fresh process resumes the stored session before prompting it", async () => {
  const h = harness();
  const first = new AcpSessionDriver(fixtureDef(), { host: h.host });
  await turn(first, ctx(h.dir, "one"));
  const sessionId = first.getSessionId()!;
  first.dispose();
  const second = new AcpSessionDriver(fixtureDef(), { host: h.host, initialSessionId: sessionId });
  try {
    const { result } = await turn(second, ctx(h.dir, "two"));
    assert.equal(result.lastAssistantText, "echo: two");
    assert.equal(second.getSessionId(), sessionId);
    assert.ok(h.received().some((message) => message.method === "session/resume" && message.params?.sessionId === sessionId));
  } finally {
    second.dispose();
    h.cleanup();
  }
});

test("a session the agent no longer knows fails that turn and starts a new one on the next", async () => {
  const h = harness();
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host, initialSessionId: "session_gone" });
  try {
    await assert.rejects(turn(driver, ctx(h.dir, "one")), /Unknown sessionId/);
    assert.equal(driver.getSessionId(), undefined);
    const { result } = await turn(driver, ctx(h.dir, "two"));
    assert.equal(result.lastAssistantText, "echo: two");
  } finally {
    driver.dispose();
    h.cleanup();
  }
});

test("history replays the stored session as turns, without the agent's injected reminders", async () => {
  const h = harness();
  const first = new AcpSessionDriver(fixtureDef(), { host: h.host });
  await turn(first, ctx(h.dir, "one"));
  await turn(first, ctx(h.dir, "[[tool]]"));
  const sessionId = first.getSessionId()!;
  first.dispose();
  const reopened = new AcpSessionDriver(fixtureDef(), { host: h.host, initialSessionId: sessionId });
  try {
    const events = await reopened.readHistory(h.dir);
    const shape = events.map((event) => (event.type === "user_message" ? `user:${event.text}` : event.type === "text" ? `text:${event.text}` : event.type));
    assert.deepEqual(shape, ["turn_started", "user:one", "text:echo: one", "turn_ended", "turn_started", "user:[[tool]]", "tool_started", "tool_ended", "text:listed", "turn_ended"]);
    // Loading attached it: the next turn needs no resume.
    await turn(reopened, ctx(h.dir, "three"));
    assert.equal(h.received().filter((message) => message.method === "session/resume").length, 0);
  } finally {
    reopened.dispose();
    h.cleanup();
  }
});

test("an agent error on the prompt reaches the session as the turn's failure, in the agent's words", async () => {
  const h = harness();
  const driver = new AcpSessionDriver(fixtureDef(), { host: h.host });
  try {
    await assert.rejects(turn(driver, ctx(h.dir, "[[fail]]")), /subscription does not have access/);
    assert.equal(driver.getSessionId(), "session_1", "a plan error is not a dead session");
  } finally {
    driver.dispose();
    h.cleanup();
  }
});
