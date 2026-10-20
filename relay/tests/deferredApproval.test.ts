import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { SessionManager as SessionManagerType } from "../src/session/sessionManager.js";
import type { McpPermissionBridge as McpPermissionBridgeType } from "../src/bridges/permissionBridge.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): a session with
// `deferredApproval` on answers the CLI's permission request on the spot, ends
// the turn, keeps the request as a persisted pending approval, and turns the
// human's verdict into a NEW turn with the permission granted. Real pieces:
// SessionManager, SharedSession, ChoiceMachine, SessionStore (on disk),
// McpPermissionBridge behind a real HTTP server, a real child process. Only
// the model is faked (FAKE_CLAUDE_REQUEST_TOOLS: a "model" that issues tool
// calls and obeys the decision it gets back).

let server: TestServer;
let SessionManager: typeof SessionManagerType;
let McpPermissionBridge: typeof McpPermissionBridgeType;
let SessionStore: typeof import("../src/session/sessionStore.js").SessionStore;
let claudeRuntimeDef: typeof import("../src/runtimes/defs/claude/index.js").claudeRuntimeDef;
let buildRegistry: typeof import("../src/runtimes/registry.js").buildRegistry;

before(async () => {
  server = await startTestServer();
  ({ SessionManager } = await import("../src/session/sessionManager.js"));
  ({ McpPermissionBridge } = await import("../src/bridges/permissionBridge.js"));
  ({ SessionStore } = await import("../src/session/sessionStore.js"));
  ({ claudeRuntimeDef } = await import("../src/runtimes/defs/claude/index.js"));
  ({ buildRegistry } = await import("../src/runtimes/registry.js"));
});

after(async () => {
  await server.close();
});

const dirs: string[] = [];
const relays: Relay[] = [];
let argvFile: string;
let workDir: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-deferred-"));
  dirs.push(dir);
  argvFile = join(dir, "argv.jsonl");
  workDir = dir;
  process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
});

afterEach(async () => {
  mock.timers.reset();
  for (const key of ["FAKE_CLAUDE_REQUEST_TOOLS", "FAKE_CLAUDE_REPLY", "FAKE_CLAUDE_ARGV_FILE"]) delete process.env[key];
  while (relays.length > 0) await relays.pop()!.stop();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Sent = {
  type: string;
  promptId?: string;
  kind?: string;
  askedAt?: number;
  questions?: { question: string; approval?: { tool: string; detail: string }; options: { id?: string; label: string }[] }[];
  mode?: string;
  event?: { type?: string; text?: string };
};

interface Relay {
  sent: Sent[];
  session: import("../src/session/sharedSession.js").SharedSession;
  bridge: McpPermissionBridgeType;
  storeFile: string;
  stop: () => Promise<void>;
}

/** A relay "process": its own store file (a copy of `seedFile` when given, as
 * after a restart), permission bridge behind a real HTTP server, one client
 * socket. Sessions that `deferred` names get `deferredApproval` on. */
async function boot(sessionId: string, options: { seedFile?: string; deferred?: boolean } = {}): Promise<Relay> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-deferred-relay-"));
  dirs.push(dir);
  const storeFile = join(dir, "sessions.json");
  if (options.seedFile) writeFileSync(storeFile, readFileSync(options.seedFile, "utf8"));
  const bridge = new McpPermissionBridge();
  const http: Server = createServer((req, res) => {
    const match = req.url?.match(/^\/permission\/([^/]+)$/);
    if (match) void bridge.handleRequest(match[1], req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  const store = new SessionStore(storeFile, server.homeDir);
  const manager = new SessionManager(
    undefined,
    store,
    buildRegistry([claudeRuntimeDef]),
    undefined,
    undefined,
    undefined,
    undefined,
    bridge,
    `http://127.0.0.1:${port}/permission`,
    undefined,
    undefined,
    undefined,
    options.deferred === false ? undefined : () => ({ deferredApproval: true }),
  );
  const sent: Sent[] = [];
  const socket = { send: (data: string) => sent.push(JSON.parse(data) as Sent), readyState: 1, OPEN: 1, on: () => {}, close: () => {} } as unknown as WebSocket;
  const session = manager.getOrCreate(sessionId);
  // The default mode (bypassPermissions) never asks anything.
  session.setPermissionMode("default");
  session.addClient(socket);
  for (let i = 0; i < 400 && !sent.some((m) => m.type === "caught_up"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(
    sent.some((m) => m.type === "caught_up"),
    "the session never finished connecting the client",
  );
  const relay: Relay = {
    sent,
    session,
    bridge,
    storeFile,
    stop: async () => {
      manager.disposeAll();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  relays.push(relay);
  return relay;
}

const OUT = () => join(workDir, "out.txt");

function ask(relay: Relay, text: string, tools: unknown[]): Promise<void> {
  process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify(tools);
  const socket = { send: () => {} } as unknown as WebSocket;
  relay.session.submitTurn(socket, text);
  return relay.session.waitForIdle();
}

function turns(): { prompt: string; allowed: string | undefined; permissionTool: string | undefined }[] {
  return readFileSync(argvFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((argv) => argv.includes("stream-json") && argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "stream-json")
    .map((argv) => ({
      prompt: argv[argv.indexOf("-p") + 1],
      allowed: argv.includes("--allowedTools") ? argv[argv.indexOf("--allowedTools") + 1] : undefined,
      permissionTool: argv.includes("--permission-prompt-tool") ? argv[argv.indexOf("--permission-prompt-tool") + 1] : undefined,
    }));
}

function lastAssistantText(relay: Relay): string {
  const texts = relay.sent.filter((m) => m.type === "agent_event" && m.event?.type === "text").map((m) => m.event?.text ?? "");
  return texts.at(-1) ?? "";
}

function storedApproval(relay: Relay, sessionId: string): { calls: { tool: string; agentId?: string }[]; promptId: string; askedAt?: number } | undefined {
  const records = JSON.parse(readFileSync(relay.storeFile, "utf8")) as Record<string, { pendingApproval?: ReturnType<typeof storedApproval> }>;
  return records[sessionId]?.pendingApproval;
}

const WRITE = { tool: "Write", input: { file_path: "", content: "hello" } };
const writeCall = () => ({ ...WRITE, input: { ...WRITE.input, file_path: OUT() } });

function prompts(relay: Relay): Sent[] {
  return relay.sent.filter((m) => m.type === "choice_prompt");
}

test("a deferred session refuses the call at once: the turn ends, nothing runs, no MCP call stays open", async () => {
  const relay = await boot("deferred-refuse");
  await ask(relay, "write the file", [writeCall()]);

  assert.equal(existsSync(OUT()), false, "the refused call must not run");
  assert.equal(relay.bridge.openCalls(), 0, "no permission request may be left open on a human");
  assert.ok(
    relay.sent.some((m) => m.type === "agent_event" && m.event?.type === "turn_ended"),
    "the turn must end without anyone answering",
  );
  assert.match(lastAssistantText(relay), /refused: Write .*\(awaiting user approval; end your turn\)/);
  const [prompt] = prompts(relay);
  assert.equal(prompt.kind, "approval");
  assert.deepEqual(prompt.questions?.[0].approval, { tool: "Write", detail: OUT() });
  assert.deepEqual(
    prompt.questions?.[0].options.map((o) => o.id),
    ["approve", "deny"],
    "the current client answers this prompt with no change",
  );
  assert.equal(storedApproval(relay, "deferred-refuse")?.calls[0].tool, "Write");
});

test("approval answered hours later, after a relay restart, runs a new turn with the permission granted and the call goes through", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = await boot("deferred-restart");
  await ask(first, "write the file", [writeCall()]);
  const asked = prompts(first)[0];
  assert.equal(existsSync(OUT()), false);
  await first.stop();

  // The relay is gone for six hours; a brand new one reads the sessions file.
  mock.timers.tick(6 * 60 * 60 * 1000);
  const second = await boot("deferred-restart", { seedFile: first.storeFile });
  const reshown = prompts(second)[0];
  assert.ok(reshown, "the pending approval must survive a restart");
  assert.equal(reshown.promptId, asked.promptId);
  assert.equal(reshown.kind, "approval");
  assert.equal(reshown.askedAt, asked.askedAt, "askedAt is when it was asked, not when it was reloaded");
  assert.ok(Date.now() - (reshown.askedAt ?? 0) >= 6 * 60 * 60 * 1000, "the simulated clock really moved");

  const accepted = second.session.answerChoice(asked.promptId!, [{ question: asked.questions![0].question, selected: ["approve"] }]);
  assert.equal(accepted, true);
  await second.session.waitForIdle();

  assert.equal(readFileSync(OUT(), "utf8"), "hello", "the approved call must have run in the follow-up turn");
  const turn = turns().at(-1)!;
  assert.match(turn.prompt, /^approved: retry the denied call/);
  assert.match(turn.prompt, new RegExp(OUT().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(turn.allowed?.split(",").includes(`Edit(/${OUT()})`), `the turn must grant the path rule, got ${String(turn.allowed)}`);
  assert.equal(second.bridge.openCalls(), 0);
  assert.equal(storedApproval(second, "deferred-restart"), undefined, "answered: the stored record is gone");
  assert.ok(second.sent.some((m) => m.type === "choice_resolved" && m.promptId === asked.promptId));
});

test("denying runs a new turn that tells the model, grants nothing, and the call never runs", async () => {
  const relay = await boot("deferred-deny");
  await ask(relay, "write the file", [writeCall()]);
  const asked = prompts(relay)[0];

  process.env.FAKE_CLAUDE_REPLY = "understood";
  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  relay.session.answerChoice(asked.promptId!, [{ question: asked.questions![0].question, selected: ["deny"] }]);
  await relay.session.waitForIdle();

  assert.equal(existsSync(OUT()), false);
  const turn = turns().at(-1)!;
  assert.match(turn.prompt, /denied/i);
  assert.match(turn.prompt, /do not retry/i);
  assert.equal(turn.allowed, undefined, "a refusal grants nothing");
  assert.equal(storedApproval(relay, "deferred-deny"), undefined);
});

test("a call from a native subagent is held on the parent session with its agent id", async () => {
  const relay = await boot("deferred-agent");
  await ask(relay, "delegate", [{ ...writeCall(), agent_id: "sub-9" }]);

  assert.equal(storedApproval(relay, "deferred-agent")?.calls[0].agentId, "sub-9");
  const question = prompts(relay)[0].questions![0];
  assert.match(question.question, /subagent sub-9/);
  assert.deepEqual(question.approval, { tool: "Write", detail: OUT() }, "the wire shape of the approval is unchanged");
});

test("several calls in one turn become ONE prompt; each is approved or denied on its own", async () => {
  const relay = await boot("deferred-many");
  const second = join(workDir, "second.txt");
  await ask(relay, "write both", [writeCall(), { tool: "Write", input: { file_path: second, content: "two" } }, { tool: "Bash", input: { command: "git status --short" } }]);

  const shown = prompts(relay);
  const last = shown.at(-1)!;
  assert.equal(last.questions?.length, 3, "one card for the whole turn");
  assert.equal(relay.sent.filter((m) => m.type === "choice_resolved").length, shown.length - 1, "superseded cards are dismissed");

  const answers = last.questions.map((q, i) => ({ question: q.question, selected: [i === 1 ? "deny" : "approve"] }));
  relay.session.answerChoice(last.promptId!, answers);
  await relay.session.waitForIdle();

  const turn = turns().at(-1)!;
  assert.deepEqual(turn.allowed?.split(","), [`Edit(/${OUT()})`, "Bash(git status --short)"], "only what was approved is granted");
  assert.match(turn.prompt, /denied/i, "the refused one is reported too");
  assert.equal(readFileSync(OUT(), "utf8"), "hello");
  assert.equal(existsSync(second), false);
});

test("typing a new message instead of answering dismisses the pending approval, stored copy included", async () => {
  const relay = await boot("deferred-moveon");
  await ask(relay, "write the file", [writeCall()]);
  const asked = prompts(relay)[0];

  process.env.FAKE_CLAUDE_REPLY = "ok";
  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "never mind");
  await relay.session.waitForIdle();

  assert.ok(relay.sent.some((m) => m.type === "choice_resolved" && m.promptId === asked.promptId));
  assert.equal(storedApproval(relay, "deferred-moveon"), undefined);
});

test("an ordinary session is untouched: the approval blocks the turn until answered, and the call runs on approve", async () => {
  const relay = await boot("ordinary-blocks", { deferred: false });
  process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify([writeCall()]);
  relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "write the file");

  while (prompts(relay).length === 0) await new Promise((r) => setTimeout(r, 5));
  const asked = prompts(relay)[0];
  assert.equal(relay.bridge.openCalls(), 1, "the CLI is still waiting on the human");
  assert.equal(existsSync(OUT()), false);
  assert.equal(storedApproval(relay, "ordinary-blocks"), undefined, "a blocking approval is never persisted");

  relay.session.answerChoice(asked.promptId!, [{ question: asked.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();
  assert.equal(readFileSync(OUT(), "utf8"), "hello");
  assert.equal(turns().length, 1, "one turn, no follow-up");
  assert.equal(turns()[0].allowed, undefined);
});

test("approving ExitPlanMode on a deferred session leaves plan mode, and the follow-up turn runs in the new mode", async () => {
  const relay = await boot("deferred-plan");
  relay.session.setPermissionMode("plan");
  await ask(relay, "plan it", [{ tool: "ExitPlanMode", input: { plan: "do the thing" } }]);
  const asked = prompts(relay)[0];
  assert.match(asked.questions![0].question, /leave Plan mode/);

  process.env.FAKE_CLAUDE_REPLY = "executing";
  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  relay.session.answerChoice(asked.promptId!, [{ question: asked.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();

  assert.equal(relay.sent.filter((m) => m.type === "permission_mode_state").at(-1)?.mode, "default");
  assert.match(turns().at(-1)!.prompt, /leave plan mode/);
});
