import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { assertTurnEnded, collectUntil, connectSessionAndCollectUntil, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// A Kimi Code session end to end over the real WebSocket protocol, against
// the real relay and the real ACP engine; only `kimi` itself is the fake
// ACP agent (`fixtures/fake-acp-agent.mjs`, shapes of Kimi Code CLI 2.6.0),
// put first on the relay's PATH as a `kimi` wrapper.
const FAKE_ACP_AGENT = resolve(import.meta.dirname, "fixtures/fake-acp-agent.mjs");

let server: TestServer;
let dir: string;
let LOG: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-kimi-session-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "kimi"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ACP_AGENT}" "$@"\n`);
  chmodSync(join(binDir, "kimi"), 0o755);
  process.env.PATH = [binDir, process.env.PATH ?? ""].join(delimiter);
  process.env.FAKE_ACP_STATE = join(dir, "acp-state.json");
  process.env.FAKE_ACP_IDLE_EXIT_MS = "1000";
  LOG = join(dir, "acp-log.jsonl");
  process.env.KIMI_CODE_HOME = join(dir, "kimi-home");
  process.env.FAKE_ACP_LOG = LOG;
  server = await startTestServer();
  // Inherited from a shell, it could put a real `kimi` ahead of the fake.
  process.env.EXTRA_PATH_DIRS = "";
});

after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function kimiSession(sessionId: string): Promise<WebSocket> {
  const { socket } = await connectSessionAndCollectUntil(server.port, sessionId, (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  await collectUntil(socket, (message) => message.type === "permission_mode_state");
  return socket;
}

function events(messages: Record<string, unknown>[]): { type: string; [key: string]: unknown }[] {
  return messages.filter((message) => message.type === "agent_event").map((message) => message.event as { type: string });
}

test("switching to Kimi offers Kimi's own four modes", async () => {
  const { socket } = await connectSessionAndCollectUntil(server.port, "kimi-modes", (message) => message.type === "caught_up");
  socket.send(JSON.stringify({ type: "set_agent", agentId: "kimi" }));
  const messages = await collectUntil(socket, (message) => message.type === "permission_mode_state");
  const modes = messages.find((message) => message.type === "permission_mode_state") as { mode: string; available: { id: string }[] };
  assert.equal(modes.mode, "default");
  assert.deepEqual(
    modes.available.map((mode) => mode.id),
    ["default", "plan", "auto", "yolo"],
  );
  socket.close();
});

test("a turn streams Kimi's thought and reply and ends with the context it reported", async () => {
  const socket = await kimiSession("kimi-turn");
  sendUserMessage(socket, "hello kimi");
  const messages = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(messages.find(isTurnEnded), false);
  const log = events(messages);
  assert.ok(log.some((event) => event.type === "thinking"));
  assert.ok(log.some((event) => event.type === "text" && event.text === "echo: hello kimi"));
  const usage = messages.filter((message) => message.type === "context_usage_state").at(-1) as { usage?: { contextWindowSize?: number; usedTokens?: number } } | undefined;
  assert.equal(usage?.usage?.contextWindowSize, 1000);
  socket.close();
});

type ApprovalPrompt = { type: string; promptId: string; kind?: string; questions: { options: { id?: string }[]; approval?: { tool: string; detail: string } }[] };

const isApprovalPrompt = (message: Record<string, unknown>): boolean => message.type === "choice_prompt" && message.kind === "approval";

function approvalPrompt(messages: Record<string, unknown>[]): ApprovalPrompt | undefined {
  return messages.filter(isApprovalPrompt).at(-1) as ApprovalPrompt | undefined;
}

/** The option Kimi got back for each permission request, in the order the
 * relay answered them. */
function permissionAnswers(): string[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; result?: { outcome?: { optionId?: string; outcome?: string } } })
    .filter((message) => message.method === undefined && message.result?.outcome !== undefined)
    .map((message) => message.result?.outcome?.optionId ?? message.result?.outcome?.outcome ?? "");
}

test("after a turn the context is broken down with Kimi's estimated setup, and no tool call is given a share of the turn", async () => {
  const socket = await kimiSession("kimi-breakdown");
  sendUserMessage(socket, "[[tool]]");
  // The estimate is worked out once the turn is over, without the popover asking.
  const messages = await collectUntil(socket, (message) => message.type === "context_usage_state" && (message as { usage?: { breakdown?: unknown } }).usage?.breakdown !== undefined);
  const usage = (messages.at(-1) as { usage: { usedTokens: number; baselineTokens?: number; breakdown: { residual?: { tokens: number; estimated: boolean } } } }).usage;
  assert.deepEqual(usage.breakdown.residual, { tokens: 13000, estimated: true });
  // The fake reports far less than Kimi's real setup: the setup never exceeds what is used.
  assert.equal(usage.baselineTokens, usage.usedTokens);
  assert.ok(!events(messages).some((event) => event.type === "context_attribution"));
  socket.close();
});

test("a command approval doesn't hold Kimi: it is refused at once and kept as a card, and approving it runs the call in a new turn", async () => {
  const socket = await kimiSession("kimi-approval");
  const before = permissionAnswers().length;
  sendUserMessage(socket, "[[tool]]");
  // The card goes out as the turn is wrapped up, after its `turn_ended`.
  const first = await collectUntil(socket, isApprovalPrompt);
  assertTurnEnded(first.find(isTurnEnded), false);
  assert.ok(events(first).some((event) => event.type === "text" && event.text === "refused"), "the turn ended instead of waiting on a person");
  const prompt = approvalPrompt(first);
  assert.ok(prompt, "the approval is published when the turn ends");
  assert.deepEqual(prompt.questions[0].approval, { tool: "Bash", detail: "ls" });
  assert.deepEqual(
    prompt.questions[0].options.map((option) => option.id),
    ["accept", "acceptForSession", "decline"],
  );

  // A device that connects later (hours later, say) still gets the card.
  const { socket: late, messages: burst } = await connectSessionAndCollectUntil(server.port, "kimi-approval", (message) => message.type === "caught_up");
  assert.equal(approvalPrompt(burst)?.promptId, prompt.promptId);
  late.close();

  socket.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: [{ question: "", selected: ["acceptForSession"] }] }));
  const second = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(second.find(isTurnEnded), false);
  assert.ok(!second.some(isApprovalPrompt), "Kimi's repeat of the approved call is not asked about again");
  const ended = events(second).find((event) => event.type === "tool_ended") as { content?: string; isError?: boolean } | undefined;
  assert.equal(ended?.content, "file.txt\n");
  assert.ok(events(second).some((event) => event.type === "text" && event.text === "ran"));
  assert.deepEqual(permissionAnswers().slice(before), ["reject", "approve_always"], "the repeat got the decision the person picked");
  socket.close();
});

test("approvals Kimi asks for at once become one card, and only the approved call runs", async () => {
  const socket = await kimiSession("kimi-parallel");
  sendUserMessage(socket, "[[tools2]]");
  const first = await collectUntil(socket, isApprovalPrompt);
  assertTurnEnded(first.find(isTurnEnded), false);
  const prompt = approvalPrompt(first);
  assert.ok(prompt, "no approval card");
  assert.deepEqual(
    prompt.questions.map((question) => question.approval?.detail),
    ["ls", "pwd"],
    "neither request is lost",
  );
  socket.send(
    JSON.stringify({
      type: "choice_answer",
      promptId: prompt.promptId,
      answers: [
        { question: "", selected: ["accept"] },
        { question: "", selected: ["decline"] },
      ],
    }),
  );
  const second = await collectUntil(socket, isTurnEnded);
  assert.ok(!second.some(isApprovalPrompt));
  assert.ok(events(second).some((event) => event.type === "text" && event.text === "ran"), "only the approved call is repeated, and it runs");
  socket.close();
});

test("an approval asked in a turn Kimi started on its own reaches the person, and the session isn't stuck behind it", async () => {
  const socket = await kimiSession("kimi-background");
  sendUserMessage(socket, "[[background]]");
  const first = await collectUntil(socket, isTurnEnded);
  assert.ok(events(first).some((event) => event.type === "text" && event.text === "started"));
  // No turn of the session is running when Kimi asks.
  const asked = await collectUntil(socket, isApprovalPrompt);
  const prompt = approvalPrompt(asked);
  assert.equal(prompt?.questions[0].approval?.detail, "make build");
  // Kimi was answered already: a new message is not queued behind the card.
  sendUserMessage(socket, "anyone there?");
  const reply = await collectUntil(socket, isTurnEnded);
  assert.ok(events(reply).some((event) => event.type === "text" && event.text === "echo: anyone there?"));
  socket.close();
});

test("in yolo, an approval Kimi asks for anyway is answered yes by the relay, and no card is shown", async () => {
  // Kimi's own guard asks before a command it finds dangerous even in yolo;
  // the fake asks before every Bash call, which stands in for that.
  const socket = await kimiSession("kimi-yolo");
  socket.send(JSON.stringify({ type: "set_permission_mode", mode: "yolo" }));
  await collectUntil(socket, (message) => message.type === "permission_mode_state" && message.mode === "yolo");
  const before = permissionAnswers().length;
  sendUserMessage(socket, "[[tool]]");
  const messages = await collectUntil(socket, isTurnEnded);
  assert.ok(!messages.some(isApprovalPrompt), "yolo never pauses");
  assert.ok(events(messages).some((event) => event.type === "text" && event.text === "listed"));
  assert.deepEqual(permissionAnswers().slice(before), ["approve_once"], "approved for this call only, not for the session");
  socket.close();
});

test("a turn Kimi failed but answered as ended shows as a failure, with Kimi's own message", async () => {
  // A spent quota: Kimi answers `end_turn` and only its session log says why.
  const socket = await kimiSession("kimi-quota");
  sendUserMessage(socket, "[[quota]]");
  // A failed turn ends without a `turn_ended`, on the idle `turn_state`.
  const messages = await collectUntil(socket, (message) => message.type === "turn_state" && message.active === false);
  const error = events(messages).find((event) => event.type === "error") as { message?: string } | undefined;
  assert.match(error?.message ?? "", /5-hour usage limit/);
  // What it said before failing is committed, not lost with the turn.
  assert.ok(events(messages).some((event) => event.type === "text" && event.text === "halfway"));
  socket.close();
});

test("Kimi's question tool shows as a choice card and the label picked is the answer", async () => {
  const socket = await kimiSession("kimi-question");
  sendUserMessage(socket, "[[question]]");
  const prompted = await collectUntil(socket, (message) => message.type === "choice_prompt");
  const prompt = prompted.at(-1) as { promptId: string; questions: { question: string; header?: string; options: { label: string }[] }[] };
  assert.equal(prompt.questions[0].question, "Pick one");
  assert.deepEqual(
    prompt.questions[0].options.map((option) => option.label),
    ["Red", "Blue"],
  );
  assert.ok(!events(prompted).some((event) => event.type === "tool_started"), "the question tool itself never shows as a tool card");
  socket.send(JSON.stringify({ type: "choice_answer", promptId: prompt.promptId, answers: [{ question: "Pick one", selected: ["Blue"] }] }));
  const rest = await collectUntil(socket, isTurnEnded);
  assert.ok(events(rest).some((event) => event.type === "text" && event.text === "answer: Blue"));
  socket.close();
});

test("an approval whose call Kimi never described waits as an ordinary one, and Stop releases it", async () => {
  // `[[hang]]` asks with no input anywhere: nothing could recognise a repeat,
  // so the request is held open instead of deferred.
  const socket = await kimiSession("kimi-stop");
  sendUserMessage(socket, "[[hang]]");
  const prompted = await collectUntil(socket, isApprovalPrompt);
  assert.ok(!prompted.some(isTurnEnded), "the turn is still waiting on the approval");
  socket.send(JSON.stringify({ type: "stop_turn" }));
  const stopped = await collectUntil(socket, isTurnEnded);
  assertTurnEnded(stopped.find(isTurnEnded), true);
  sendUserMessage(socket, "still there?");
  const next = await collectUntil(socket, isTurnEnded);
  assert.ok(events(next).some((event) => event.type === "text" && event.text === "echo: still there?"));
  socket.close();
});

test("Kimi's model catalog reaches clients, each model with its own reasoning levels", async () => {
  // Probed in the background once detection finds `kimi`; a connection made
  // after that carries it.
  type Catalogs = { catalogs: Record<string, { options: { id: string; efforts?: { id: string }[] }[]; defaultId?: string }> };
  let state: Catalogs | undefined;
  for (let attempt = 0; attempt < 100 && !state?.catalogs.kimi; attempt++) {
    // Sent right after the connection's history burst, so after `caught_up`.
    const { socket, messages } = await connectSessionAndCollectUntil(server.port, `kimi-catalog-${attempt}`, (message) => message.type === "model_catalogs_state");
    socket.close();
    state = messages.at(-1) as Catalogs | undefined;
    if (!state?.catalogs.kimi) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const kimi = state?.catalogs.kimi;
  assert.ok(kimi, "no kimi catalog was ever published");
  assert.equal(kimi.defaultId, "m1");
  assert.deepEqual(
    kimi.options.map((option) => [option.id, option.efforts?.map((effort) => effort.id)]),
    [
      ["m1", ["low", "high", "max"]],
      ["m2", ["on", "high"]],
    ],
  );
});
