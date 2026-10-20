import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
let codexRuntimeDef: typeof import("../src/runtimes/defs/codex.js").codexRuntimeDef;
let buildRegistry: typeof import("../src/runtimes/registry.js").buildRegistry;

before(async () => {
  server = await startTestServer();
  ({ SessionManager } = await import("../src/session/sessionManager.js"));
  ({ McpPermissionBridge } = await import("../src/bridges/permissionBridge.js"));
  ({ SessionStore } = await import("../src/session/sessionStore.js"));
  ({ claudeRuntimeDef } = await import("../src/runtimes/defs/claude/index.js"));
  ({ codexRuntimeDef } = await import("../src/runtimes/defs/codex.js"));
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
  // Resolved: a grant is refused for a path that goes through a symlink
  // (macOS's tmpdir does).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anywh-deferred-")));
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
  manager: SessionManagerType;
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
    buildRegistry([claudeRuntimeDef, codexRuntimeDef]),
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
    manager,
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

test("a subagent's call is recognised from the stream when the permission request carries no agent id", async () => {
  const relay = await boot("deferred-agent-derived");
  await ask(relay, "delegate", [{ ...writeCall(), subagent_of: "toolu_agent_call" }]);

  assert.equal(storedApproval(relay, "deferred-agent-derived")?.calls[0].agentId, "toolu_agent_call");
  assert.match(prompts(relay)[0].questions![0].question, /subagent toolu_agent_call/);
});

test("several calls in one turn become ONE card, published once when the turn ends, answerable by its id; each is approved or denied on its own", async () => {
  const relay = await boot("deferred-many");
  const second = join(workDir, "second.txt");
  await ask(relay, "write both", [writeCall(), { tool: "Write", input: { file_path: second, content: "two" } }, { tool: "Bash", input: { command: "git status --short" } }]);

  const shown = prompts(relay);
  assert.equal(shown.length, 1, "one card, published once: it must not be reset by each refused call");
  assert.equal(relay.sent.filter((m) => m.type === "choice_resolved").length, 0);
  const card = shown[0];
  assert.equal(card.questions?.length, 3);

  const answers = card.questions.map((q, i) => ({ question: q.question, selected: [i === 1 ? "deny" : "approve"] }));
  assert.equal(relay.session.answerChoice(card.promptId!, answers), true, "the id the person saw is the id that works");
  await relay.session.waitForIdle();

  const turn = turns().at(-1)!;
  assert.deepEqual(turn.allowed?.split(","), [`Edit(/${OUT()})`, "Bash(git status --short)"], "only what was approved is granted");
  assert.match(turn.prompt, /denied/i, "the refused one is reported too");
  assert.equal(readFileSync(OUT(), "utf8"), "hello");
  assert.equal(existsSync(second), false);
});

test("approving one Bash call and denying another gives Bash to neither: no tool-wide rule, and the model is told it will be asked again", async () => {
  const relay = await boot("deferred-mixed-bash");
  await ask(relay, "run both", [
    { tool: "Bash", input: { command: "ls | head" } },
    { tool: "Bash", input: { command: "rm -rf ~/x" } },
  ]);
  const card = prompts(relay)[0];
  assert.match(card.questions![0].approval!.detail, /approving allows every Bash call during the next turn/, "the card warns what approving would allow");

  relay.session.answerChoice(card.promptId!, [
    { question: card.questions![0].question, selected: ["approve"] },
    { question: card.questions![1].question, selected: ["deny"] },
  ]);
  await relay.session.waitForIdle();

  const turn = turns().at(-1)!;
  assert.equal(turn.allowed, undefined, "no rule at all: the denied rm must not be able to run unasked");
  assert.match(turn.prompt, /asked again/);
  assert.match(turn.prompt, /denied by the user/);
});

test("approving every Bash call of the prompt does give the tool-wide rule", async () => {
  const relay = await boot("deferred-all-bash");
  await ask(relay, "run both", [
    { tool: "Bash", input: { command: "ls | head" } },
    { tool: "Bash", input: { command: "echo hi > /dev/null" } },
  ]);
  const card = prompts(relay)[0];
  relay.session.answerChoice(card.promptId!, card.questions!.map((q) => ({ question: q.question, selected: ["approve"] })));
  await relay.session.waitForIdle();
  assert.deepEqual(turns().at(-1)!.allowed?.split(","), ["Bash"]);
});

test("approving an edit of app/[id]/page.tsx (no safe rule names it) converges: granted tool-wide on the second turn, with the warning on the card", async () => {
  const relay = await boot("deferred-bracket");
  const page = join(workDir, "app", "[id]", "page.tsx");
  mkdirSync(join(workDir, "app", "[id]"), { recursive: true });
  await ask(relay, "write it", [{ tool: "Write", input: { file_path: page, content: "x" } }]);
  const card = prompts(relay)[0];
  assert.match(card.questions![0].approval!.detail, /approving allows every file-edit call during the next turn/);
  relay.session.answerChoice(card.promptId!, [{ question: card.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();
  assert.equal(turns().at(-1)!.allowed, "Write");
  assert.equal(readFileSync(page, "utf8"), "x", "it ran in the follow-up turn");
  assert.equal(prompts(relay).length, 1, "no second card: it converged");
});

test("the same edit with a refused sibling is not granted tool-wide, and the model is told it will be asked again", async () => {
  const relay = await boot("deferred-bracket-sibling");
  const page = join(workDir, "app", "[id]", "page.tsx");
  await ask(relay, "write both", [{ tool: "Write", input: { file_path: page, content: "x" } }, writeCall()]);
  const card = prompts(relay)[0];
  relay.session.answerChoice(card.promptId!, [
    { question: card.questions![0].question, selected: ["approve"] },
    { question: card.questions![1].question, selected: ["deny"] },
  ]);
  await relay.session.waitForIdle();
  const turn = turns().at(-1)!;
  assert.equal(turn.allowed, undefined);
  assert.match(turn.prompt, /asked again/);
});

test("Edit approved and Write refused on the same file: the narrow rule would let the refused one through, so it is not given", async () => {
  const relay = await boot("deferred-same-target");
  await ask(relay, "both", [{ tool: "Edit", input: { file_path: OUT(), old_string: "a", new_string: "b" } }, writeCall()]);
  const card = prompts(relay)[0];
  relay.session.answerChoice(card.promptId!, [
    { question: card.questions![0].question, selected: ["approve"] },
    { question: card.questions![1].question, selected: ["deny"] },
  ]);
  await relay.session.waitForIdle();
  assert.equal(turns().at(-1)!.allowed, undefined);
  assert.equal(existsSync(OUT()), false, "the refused write did not happen");
});

test("a turn the person stops drops its refusals, and the next message tells the model the approval was withdrawn", async () => {
  const relay = await boot("deferred-stop");
  const ready = join(workDir, "ready");
  process.env.FAKE_CLAUDE_HOLD_AFTER_TOOLS = ready;
  try {
    process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify([writeCall()]);
    relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "write the file");
    while (!existsSync(ready)) await new Promise((r) => setImmediate(r));
    relay.session.stopTurn();
    await relay.session.waitForIdle();
  } finally {
    delete process.env.FAKE_CLAUDE_HOLD_AFTER_TOOLS;
  }
  assert.equal(prompts(relay).length, 0, "nothing is asked about a turn that was stopped");
  assert.equal(storedApproval(relay, "deferred-stop"), undefined);
  assert.equal((JSON.parse(readFileSync(relay.storeFile, "utf8")) as Record<string, { withdrawnApproval?: boolean }>)["deferred-stop"].withdrawnApproval, true, "remembered across a restart");

  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  process.env.FAKE_CLAUDE_REPLY = "ok";
  relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "carry on");
  await relay.session.waitForIdle();
  assert.match(turns().at(-1)!.prompt, /^carry on\n\n\[anywh-note\] \(the pending approval request was withdrawn/);

  relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "and again");
  await relay.session.waitForIdle();
  assert.equal(turns().at(-1)!.prompt, "and again", "the note is said once");
});

test("a refusal from a later turn waits, persisted, behind the card on screen and becomes the next card once it is answered", async () => {
  const relay = await boot("deferred-queue");
  await ask(relay, "write the file", [writeCall()]);
  const first = prompts(relay)[0];

  const second = join(workDir, "second.txt");
  process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify([{ tool: "Write", input: { file_path: second, content: "2" }, tool_use_id: "toolu_second" }]);
  relay.session.submitWakeup("wake up");
  await relay.session.waitForIdle();
  assert.equal(prompts(relay).length, 1, "the card on screen is not replaced");
  const onDisk = JSON.parse(readFileSync(relay.storeFile, "utf8")) as Record<string, { queuedApproval?: { calls: { tool: string }[] } }>;
  assert.equal(onDisk["deferred-queue"].queuedApproval?.calls.length, 1, "what waits is persisted");

  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  process.env.FAKE_CLAUDE_REPLY = "ok";
  relay.session.answerChoice(first.promptId!, [{ question: first.questions![0].question, selected: ["deny"] }]);
  await relay.session.waitForIdle();
  const shown = prompts(relay);
  assert.equal(shown.length, 2);
  assert.notEqual(shown[1].promptId, first.promptId);
  assert.equal(shown[1].questions![0].approval!.detail, second);
});

test("the follow-up turn is a synthetic one: marked on the wire, and it does not feed the title", async () => {
  const relay = await boot("deferred-synthetic");
  await ask(relay, "write the file", [writeCall()]);
  const asked = prompts(relay)[0];
  relay.session.answerChoice(asked.promptId!, [{ question: asked.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();

  const followUp = relay.sent.find((m) => m.type === "agent_event" && m.event?.type === "user_message" && m.event.text?.startsWith("approved:"));
  assert.equal((followUp?.event as { synthetic?: string } | undefined)?.synthetic, "approval");
  const titleCalls = readFileSync(argvFile, "utf8").trim().split("\n").filter((line) => (JSON.parse(line) as string[]).includes("text"));
  assert.ok(!titleCalls.some((line) => line.includes("approved: retry")), "the continuation must not be used as the first prompt of the title");
});

test("what is persisted of a call is small: a big Write is cut, the path stays whole", async () => {
  const relay = await boot("deferred-big");
  const content = "z".repeat(50_000);
  await ask(relay, "write big", [{ tool: "Write", input: { file_path: OUT(), content } }]);
  const raw = readFileSync(relay.storeFile, "utf8");
  assert.ok(raw.length < 20_000, `the sessions file must not carry the whole content (${raw.length} bytes)`);
  const call = (JSON.parse(raw) as Record<string, { pendingApproval: { calls: { input: { file_path: string; content: string } }[] } }>)["deferred-big"].pendingApproval.calls[0];
  assert.equal(call.input.file_path, OUT());
  assert.match(call.input.content, /truncated/);
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
  assert.match(turns().at(-1)!.prompt, /^never mind\n\n\[anywh-note\] \(the pending approval request was withdrawn by the user; do not wait for it\)$/);
  const echoed = relay.sent.filter((m) => m.type === "agent_event" && m.event?.type === "user_message");
  assert.ok(echoed.every((m) => !JSON.stringify(m).includes("withdrawn")), "the note is for the model, not for the chat");
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

test("approving a card with a broad edit grant does not let a call waiting behind it run unasked", async () => {
  const relay = await boot("deferred-waiting");
  const page = join(workDir, "app", "[id]", "page.tsx");
  await ask(relay, "write it", [{ tool: "Write", input: { file_path: page, content: "x" }, tool_use_id: "toolu_a" }]);
  const first = prompts(relay)[0];

  process.env.FAKE_CLAUDE_REQUEST_TOOLS = JSON.stringify([{ tool: "Write", input: { file_path: join(workDir, "b.txt"), content: "b" }, tool_use_id: "toolu_b" }]);
  relay.session.submitWakeup("wake up");
  await relay.session.waitForIdle();

  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  process.env.FAKE_CLAUDE_REPLY = "ok";
  relay.session.answerChoice(first.promptId!, [{ question: first.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();
  const turn = turns().find((t) => t.prompt.startsWith("approved:"))!;
  assert.equal(turn.allowed, undefined, "a tool-wide Write would also run the call that is still waiting");
  assert.match(turn.prompt, /asked again/);
});

test("the permission shown on the card is the one used when it is answered, even if the folder changed meanwhile", async () => {
  const relay = await boot("deferred-stored-rule");
  const dir = join(workDir, "real");
  mkdirSync(dir);
  const file = join(dir, "f.txt");
  await ask(relay, "write it", [{ tool: "Write", input: { file_path: file, content: "x" } }]);
  const card = prompts(relay)[0];
  assert.doesNotMatch(card.questions![0].approval!.detail, /approving allows/, "a single-file rule: nothing to warn about");

  // Hours later the folder is a symlink to somewhere else.
  rmSync(dir, { recursive: true });
  mkdirSync(join(workDir, "elsewhere"));
  symlinkSync(join(workDir, "elsewhere"), dir);
  relay.session.answerChoice(card.promptId!, [{ question: card.questions![0].question, selected: ["approve"] }]);
  await relay.session.waitForIdle();
  const turn = turns().at(-1)!;
  assert.equal(turn.allowed, undefined, "never wider than what the card showed");
  assert.match(turn.prompt, /asked again/);
});

test("switching to another agent and back keeps the withdrawal owed to the Claude conversation that heard to wait", async () => {
  const relay = await boot("deferred-switch");
  await ask(relay, "write the file", [writeCall()]);
  assert.equal(prompts(relay).length, 1);

  relay.manager.setAgent("deferred-switch", "codex");
  assert.equal(storedApproval(relay, "deferred-switch"), undefined, "the card does not follow the conversation to another agent");
  relay.manager.setAgent("deferred-switch", "claude");

  delete process.env.FAKE_CLAUDE_REQUEST_TOOLS;
  process.env.FAKE_CLAUDE_REPLY = "ok";
  relay.session.submitTurn({ send: () => {} } as unknown as WebSocket, "carry on");
  await relay.session.waitForIdle();
  assert.match(turns().at(-1)!.prompt, /\[anywh-note\] \(the pending approval request was withdrawn/, "Claude is told, whatever happened in between");
});
