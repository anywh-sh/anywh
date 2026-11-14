import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCoherent } from "../registry.js";
import { estimateRuleTokens, estimateSkillsTokens } from "../../context/breakdown.js";
import { BILLED_CREDENTIAL_VARS } from "../executables.js";
import type { ApprovalRequest } from "../types.js";
import type { AcpPermissionParams } from "./acp.js";
import { acpApprovalRequest } from "./acp.js";
import { classifyKimiFailure, kimiApprovalParams, kimiDeferrable, parseKimiTurnFailure, kimiQuestion, kimiRuntimeDef, parseKimiProviderList } from "./kimi.js";

// Shapes recorded from Kimi Code CLI 2.6.0 (`kimi acp`, `kimi provider list`).
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../tests/fixtures/kimi-acp-2.6.0-updates.json"), "utf8")) as { questionTurn: unknown[] };

function exec() {
  if (kimiRuntimeDef.exec.kind !== "jsonRpcDaemon") throw new Error("expected jsonRpcDaemon");
  return kimiRuntimeDef.exec;
}

test("kimiRuntimeDef is coherent", () => {
  assert.deepEqual(assertCoherent(kimiRuntimeDef), []);
});

test("every credential Kimi bills through is also stripped from the terminal and the probes", () => {
  for (const name of kimiRuntimeDef.identity.env.strip) assert.ok((BILLED_CREDENTIAL_VARS as readonly string[]).includes(name), name);
});

test("the daemon is `kimi acp`, found where the installer puts it", () => {
  assert.deepEqual(exec().args, ["acp"]);
  assert.equal(exec().protocol, "acp");
  assert.deepEqual(kimiRuntimeDef.identity.binDirs, [".kimi-code/bin"]);
});

test("auth: `kimi provider list` names a provider when logged in and none when not", () => {
  const loggedIn = { stdout: "managed:kimi-code  type=kimi  models=6  source=oauth\n\nDefault model: kimi-code/kimi-for-coding\n", stderr: "", exitCode: 0 };
  const loggedOut = { stdout: "No providers configured.\n", stderr: "", exitCode: 0 };
  assert.deepEqual(parseKimiProviderList(loggedIn), { loggedIn: true });
  assert.deepEqual(parseKimiProviderList(loggedOut), { loggedIn: false });
  assert.deepEqual(kimiRuntimeDef.auth.loginCommand, ["login"]);
});

test("the turn's picks become Kimi's own settings, mode first and the level after the model", () => {
  const specs = exec().configureSession?.({ cwd: "/p", prompt: "hi", permissionModeId: "yolo", modelId: "kimi-code/k3", effortId: "max" }, "s1");
  assert.deepEqual(specs, [
    { method: "session/set_mode", params: { sessionId: "s1", modeId: "yolo" } },
    { method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "kimi-code/k3" } },
    { method: "session/set_config_option", params: { sessionId: "s1", configId: "thinking", value: "max" } },
  ]);
  assert.deepEqual(exec().configureSession?.({ cwd: "/p", prompt: "hi", permissionModeId: "default" }, "s1"), [{ method: "session/set_mode", params: { sessionId: "s1", modeId: "default" } }]);
});

test("permissions: Kimi's four modes, and only yolo never pauses", () => {
  const modes = kimiRuntimeDef.permissions.modesFor("linux");
  assert.deepEqual(modes.map((mode) => [mode.id, mode.pausesForApproval]), [["default", true], ["plan", true], ["auto", true], ["yolo", false]]);
  assert.deepEqual(kimiRuntimeDef.permissions.modesFor("win32").map((mode) => mode.id), modes.map((mode) => mode.id));
});

test("a recorded AskUserQuestion request becomes one question with the answers as options", () => {
  const request = (fixture.questionTurn.find((entry) => typeof entry === "object" && entry !== null && "__request_permission" in entry) as { __request_permission: AcpPermissionParams }).__request_permission;
  // The driver adds back the input an earlier update carried.
  const rawInput = { questions: [{ question: "Which color do you prefer?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }] };
  const asked = kimiQuestion({ ...request, toolCall: { ...request.toolCall, rawInput } });
  assert.deepEqual(asked.question, { id: request.toolCall?.toolCallId, question: "Which color do you prefer?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] });
  assert.equal(asked.optionForLabel.get("Blue"), "q0_opt_1");
  assert.equal(asked.dismissOptionId, "q0_skip");
  // Without the input, the request's own text still asks the question.
  assert.equal(kimiQuestion(request).question.question, "Which color do you prefer?");
});

test("a question goes to the choice card, anything else to the approval prompt", async () => {
  const handle = exec().handleServerRequest;
  const calls: string[] = [];
  const host = {
    requestApproval: () => (calls.push("approval"), Promise.resolve("accept")),
    requestUserInput: () => (calls.push("question"), Promise.resolve([{ questionId: "q", values: ["Red"] }])),
  };
  await handle("session/request_permission", { options: [{ optionId: "q0_opt_0", name: "Red", kind: "allow_once" }], toolCall: { title: "AskUserQuestion" } }, host);
  await handle("session/request_permission", { options: [{ optionId: "approve_once", kind: "allow_once" }], toolCall: { title: "Bash" } }, host);
  assert.deepEqual(calls, ["question", "approval"]);
  assert.equal(handle("fs/read_text_file", {}, host), undefined, "requests the relay never offered are refused");
});

test("failures: a model outside the plan is a usage limit, not a logout", () => {
  assert.equal(classifyKimiFailure({ text: "Authentication required: Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.", code: -32000 }), "usage-limit");
  assert.equal(classifyKimiFailure({ text: "Authentication required: please log in", code: -32000 }), "auth");
  assert.equal(classifyKimiFailure({ text: "Invalid params: Unknown sessionId: session_x", code: -32602 }), "session-invalid");
  assert.equal(classifyKimiFailure({ text: "socket hang up" }), "transient");
});

test("an approval that arrives before the call's input shows the command or path Kimi's own sentence names", () => {
  const ask = (text: string, title: string) => acpApprovalRequest(kimiApprovalParams({ options: [], toolCall: { toolCallId: "t", title, content: [{ type: "content", content: { type: "text", text } }] } })).request.detail;
  // Both sentences as Kimi Code 2.6.0 sent them, ahead of any input.
  assert.deepEqual(ask("Requesting approval to Running: ls -la", "Bash"), { kind: "Bash", text: "ls -la" });
  assert.deepEqual(ask("Requesting approval to Writing /work/smoke.txt", "Write"), { kind: "Write", text: "/work/smoke.txt" });
  assert.deepEqual(ask("Requesting approval to fetch the docs", "Fetch"), { kind: "Fetch", text: "fetch the docs" });
  // An input that did arrive wins over the sentence.
  const withInput = kimiApprovalParams({ toolCall: { title: "Bash", rawInput: { command: "pwd" }, content: [{ type: "content", content: { type: "text", text: "Requesting approval to Running: ls" } }] } });
  assert.deepEqual(acpApprovalRequest(withInput).request.detail, { kind: "Bash", text: "pwd" });
});

// The options of a Bash approval as Kimi Code 2.6.0 sends them.
const BASH_OPTIONS = [
  { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

test("an approval is deferrable only with the call's real input, never recognised by Kimi's shortened sentence", async () => {
  // Kimi Code 2.6.0 cuts a long command short in its sentence.
  const sentence = [{ type: "content", content: { type: "text", text: "Requesting approval to Running: cd /work && wc…" } }];
  assert.equal(kimiDeferrable({ toolCall: { title: "Bash", content: sentence } }), undefined);
  const full = "cd /work && wc -c hello.txt && date +%Y > year.txt";
  assert.deepEqual(kimiDeferrable({ toolCall: { title: "Bash", rawInput: { command: full }, content: sentence } }), { call: { tool: "Bash", input: { command: full } } });

  let asked: ApprovalRequest | undefined;
  const host = { requestApproval: (request: ApprovalRequest) => ((asked = request), Promise.resolve("decline")), requestUserInput: () => Promise.resolve("deferred" as const) };
  const answer = await exec().handleServerRequest("session/request_permission", { options: BASH_OPTIONS, toolCall: { title: "Bash", content: sentence } }, host);
  assert.equal(asked?.deferrable, undefined, "not deferred when the input is unknown: nothing could recognise the repeat");
  assert.deepEqual(answer, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("Kimi's context accounting reproduces what was measured against 2.6.0", () => {
  const accounting = kimiRuntimeDef.contextAccounting;
  assert.ok(accounting?.skills);
  // `AGENTS.md`: cl100k tokens of the file → what it added to the first call.
  for (const [raw, measured] of [
    [47, 216],
    [1079, 1248],
    [686, 951],
  ] as const) {
    assert.ok(Math.abs(estimateRuleTokens(raw, accounting.rules) - measured) <= 63, `${raw} → ${measured}`);
  }
  // Skills: descriptions as Kimi cuts them (o200k tokens) → what they added.
  const cut = (raw: number) => Math.min(raw, accounting.skills!.descriptionMaxTokens);
  assert.equal(estimateSkillsTokens([cut(7)], accounting.skills), 72);
  assert.equal(estimateSkillsTokens([cut(253)], accounting.skills), 107);
  assert.ok(Math.abs(estimateSkillsTokens([cut(757)], accounting.skills) - 110) <= 3);
  assert.equal(estimateSkillsTokens([cut(7), cut(7), cut(7)], accounting.skills), 144);
  assert.equal(accounting.fixedSetupTokens, 13000);
});

const TURN_ENDED = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../tests/fixtures/kimi-wire-2.6.0-turn-ended.json"), "utf8")) as {
  completed: { time: number };
  failed: { time: number; error: { message: string } };
};

test("a turn Kimi recorded as failed is read off its session log, with Kimi's own message, and only for the turn that just ran", () => {
  const lines = [JSON.stringify(TURN_ENDED.completed), "not json", JSON.stringify({ type: "token_counting.turn_recorded" }), JSON.stringify(TURN_ENDED.failed)];
  const failure = parseKimiTurnFailure(lines, TURN_ENDED.failed.time - 1000);
  assert.equal(failure?.text, TURN_ENDED.failed.error.message);
  assert.equal(classifyKimiFailure(failure), "usage-limit", "a spent quota reads as a usage limit");
  // The failed record belongs to an older turn than the one that just ran.
  assert.equal(parseKimiTurnFailure(lines, TURN_ENDED.failed.time + 1), undefined);
  assert.equal(parseKimiTurnFailure([JSON.stringify(TURN_ENDED.completed)], TURN_ENDED.completed.time - 1000), undefined);
  assert.equal(parseKimiTurnFailure([], 0), undefined);
});
