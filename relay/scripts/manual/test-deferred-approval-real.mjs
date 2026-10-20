// Drives a deferred tool approval against the REAL `claude` binary (Haiku,
// at most six short turns) and prints what happened:
//
//   A. one turn asking for a Write, an Edit and a Bash call together. Every
//      call must be refused on the spot, nothing may run, no permission
//      request may stay open. The pending approval is then approved, the
//      follow-up turn must repeat the calls without being asked again, and
//      the files must end up as expected. The granted `--allowedTools` rules
//      (Edit(//abs) for Write/Edit, the exact command for Bash) are the ones
//      under test, including a Bash command with a space in it.
//   B. one turn that makes a native subagent write a file: prints whether the
//      permission request carries an agent id, then denies it and checks the
//      model is told and the file never appears.
//   C. an Edit and a Bash command with spaces in it (`mkdir <dir>`: a command
//      the CLI asks about, unlike `echo`, and with no shell redirection),
//      refused together and then approved together: both must run in the
//      follow-up turn without being asked again.
//
// FLOWS=A,B,C picks flows (default all). With STOP_AFTER_ASK=1 flow B stops
// once the subagent's request is pending, without the denial turn.
//
// The session manager, session store, permission bridge (behind a real HTTP
// server on a free port) and ChoiceMachine are the real ones, in this
// process, with data under a temp dir. The `claude` child uses the real
// $HOME (for the login) and a cwd under /tmp. Costs real model turns. Run
// from relay/:
//   node --import tsx scripts/manual/test-deferred-approval-real.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { McpPermissionBridge } from "../../src/bridges/permissionBridge.ts";
import { claudeRuntimeDef } from "../../src/runtimes/defs/claude/index.ts";
import { buildRegistry } from "../../src/runtimes/registry.ts";
import { SessionManager } from "../../src/session/sessionManager.ts";
import { SessionStore } from "../../src/session/sessionStore.ts";

const dir = mkdtempSync(join(tmpdir(), "anywh-deferred-real-"));
const work = join(dir, "work");
mkdirSync(work);
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);

const bridge = new McpPermissionBridge();
const rawCalls = [];
const http = createServer((req, res) => {
  const match = req.url?.match(/^\/permission\/([^/]+)$/);
  if (!match) return res.writeHead(404).end();
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    try {
      const message = JSON.parse(body.toString("utf8"));
      if (message.method === "tools/call") rawCalls.push(message.params?.arguments);
    } catch {
      // not JSON: the bridge answers 400
    }
    const replay = Object.assign(Readable.from([body]), { method: req.method, url: req.url });
    void bridge.handleRequest(match[1], replay, res);
  });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = http.address().port;
log(`permission bridge on 127.0.0.1:${port}, data in ${dir}`);

const store = new SessionStore(join(dir, "sessions.json"), work);
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
  () => ({ deferredApproval: true }),
);
const sent = [];
const socket = { send: (data) => sent.push(JSON.parse(data)), readyState: 1, OPEN: 1, on: () => {}, close: () => {} };
let turnsRun = 0;
const failures = [];
const check = (ok, what) => {
  log(ok ? "PASS" : "FAIL", what);
  if (!ok) failures.push(what);
};

async function runTurn(session, text) {
  turnsRun += 1;
  session.submitTurn(socket, text);
  await Promise.race([session.waitForIdle(), new Promise((_, reject) => setTimeout(() => reject(new Error("turn timed out")), 180_000))]);
}
const lastText = () => sent.filter((m) => m.type === "agent_event" && m.event?.type === "text").at(-1)?.event.text ?? "";
const toolCalls = () => sent.filter((m) => m.type === "agent_event" && m.event?.type === "tool_started").map((m) => `${m.event.tool ?? m.event.name}`);
const prompts = () => sent.filter((m) => m.type === "choice_prompt");

function newSession(id) {
  const session = manager.getOrCreate(id);
  session.setCwd(work);
  session.setModel("haiku");
  session.setPermissionMode("default");
  session.addClient(socket);
  return session;
}

const flows = (process.env.FLOWS ?? "A,B,C").split(",");
try {
  // ---- A: Write + Edit + Bash, refused together, then approved together ----
  if (flows.includes("A")) {
  const a = join(work, "a.txt");
  const b = join(work, "b.txt");
  const c = join(work, "c.txt");
  writeFileSync(b, "old value\n");
  const session = newSession("real-deferred-a");
  await new Promise((r) => setTimeout(r, 300));
  await runTurn(
    session,
    `Do these three things with your tools, issuing all three tool calls together in a single message: ` +
      `(1) use the Write tool to create ${a} containing exactly: alpha. ` +
      `(2) use the Edit tool on ${b} to replace "old value" with "new value" (read the file first). ` +
      `(3) use the Bash tool to run exactly: echo hello world > ${c}. ` +
      `If any tool call is refused, stop and tell me what was refused.`,
  );
  log("turn 1 tools:", toolCalls().join(", "));
  log("turn 1 assistant:", JSON.stringify(lastText().slice(0, 300)));
  const pending = store.getPendingApproval("real-deferred-a");
  log("pending calls:", JSON.stringify(pending?.calls));
  log("raw permission-request arguments (keys):", JSON.stringify(rawCalls.map((args) => Object.keys(args ?? {}))));
  check(!existsSync(a) && !existsSync(c) && readFileSync(b, "utf8") === "old value\n", "nothing ran while the approval was pending");
  check(bridge.openCalls() === 0, "no permission request left open");
  check(pending !== undefined && pending.calls.length >= 1, `a pending approval was persisted (${pending?.calls.length ?? 0} call(s))`);

  const prompt = prompts().at(-1);
  const answers = prompt.questions.map((q) => ({ question: q.question, selected: ["approve"] }));
  session.answerChoice(prompt.promptId, answers);
  await session.waitForIdle();
  turnsRun += 1;
  log("turn 2 tools:", toolCalls().slice(-6).join(", "));
  log("turn 2 assistant:", JSON.stringify(lastText().slice(0, 300)));
  const stillPending = store.getPendingApproval("real-deferred-a");
  log("pending after turn 2:", JSON.stringify(stillPending?.calls ?? null));
  const approvedTools = new Set(pending.calls.map((call) => call.tool));
  if (approvedTools.has("Write")) check(existsSync(a) && readFileSync(a, "utf8").trim() === "alpha", "Write repeated and done after approval");
  if (approvedTools.has("Edit")) check(readFileSync(b, "utf8").includes("new value"), "Edit repeated and done after approval");
  if (approvedTools.has("Bash")) check(existsSync(c) && readFileSync(c, "utf8").trim() === "hello world", "Bash repeated and done after approval");
  check(bridge.openCalls() === 0, "no permission request left open after the follow-up turn");
  log("approved in turn 1 but asked again in turn 2:", stillPending ? stillPending.calls.map((call) => call.tool).join(",") : "none");
  }

  // ---- B: a call from a native subagent, then a refusal ----
  if (flows.includes("B")) {
  const d = join(work, "d.txt");
  const sub = newSession("real-deferred-b");
  await new Promise((r) => setTimeout(r, 300));
  const rawBefore = rawCalls.length;
  await runTurn(
    sub,
    `Use the Agent tool to start a general-purpose subagent whose only job is to write the text "beta" to ${d} with the Write tool. ` +
      `Wait for it. If its write is refused, stop and tell me what happened.`,
  );
  log("B turn 1 tools:", toolCalls().slice(-6).join(", "));
  log("B turn 1 assistant:", JSON.stringify(lastText().slice(0, 300)));
  const subPending = store.getPendingApproval("real-deferred-b");
  log("B pending calls:", JSON.stringify(subPending?.calls));
  log("B raw permission-request arguments:", JSON.stringify(rawCalls.slice(rawBefore).map((args) => ({ ...args, input: "..." }))));
  check(subPending !== undefined, "the subagent's call was held as a pending approval");
  log("agent id carried by the permission request:", subPending?.calls.map((call) => call.agentId ?? "(none)").join(","));
  if (subPending && process.env.STOP_AFTER_ASK !== "1") {
    const subPrompt = prompts().at(-1);
    sub.answerChoice(subPrompt.promptId, subPrompt.questions.map((q) => ({ question: q.question, selected: ["deny"] })));
    await sub.waitForIdle();
    turnsRun += 1;
    log("B turn 2 assistant:", JSON.stringify(lastText().slice(0, 300)));
    check(!existsSync(d), "a denied subagent write never happened");
  }
  }

  // ---- C: Edit + Bash (`mkdir`), approved together ----
  if (flows.includes("C")) {
    const e = join(work, "e.txt");
    writeFileSync(e, "old value\n");
    const probe = newSession("real-deferred-c");
    await new Promise((r) => setTimeout(r, 300));
    await runTurn(
      probe,
      `First read ${e} with the Read tool. Then, in a single message, call the Edit tool on ${e} (replace "old value" with "new value") ` +
        `and the Bash tool to run exactly: mkdir ${join(work, "made-dir")}. If a call is refused, stop and tell me what was refused.`,
    );
    log("C turn 1 tools:", toolCalls().slice(-6).join(", "));
    const held = store.getPendingApproval("real-deferred-c");
    log("C pending calls:", JSON.stringify(held?.calls.map((call) => ({ tool: call.tool, input: call.input }))));
    check(held !== undefined && readFileSync(e, "utf8") === "old value\n", "C: calls held, nothing ran");
    if (held) {
      const heldPrompt = prompts().at(-1);
      probe.answerChoice(heldPrompt.promptId, heldPrompt.questions.map((q) => ({ question: q.question, selected: ["approve"] })));
      await probe.waitForIdle();
      turnsRun += 1;
      log("C turn 2 tools:", toolCalls().slice(-6).join(", "));
      log("C turn 2 assistant:", JSON.stringify(lastText().slice(0, 300)));
      const again = store.getPendingApproval("real-deferred-c");
      log("C asked again in turn 2:", again ? again.calls.map((call) => `${call.tool}`).join(",") : "none");
      if (held.calls.some((call) => call.tool === "Edit")) check(readFileSync(e, "utf8").includes("new value"), "C: Edit repeated and done under its Edit(//abs) rule");
      if (held.calls.some((call) => call.tool === "Bash")) {
        check(!again?.calls.some((call) => call.tool === "Bash") && existsSync(join(work, "made-dir")), "C: Bash with spaces was granted (not asked again) and ran");
      }
    }
  }
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  manager.disposeAll();
  http.closeAllConnections();
  http.close();
}
log(`turns run: ${turnsRun}; ${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${failures.join(" | ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
