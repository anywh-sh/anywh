import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type { ChoiceQuestion } from "../bridges/mcpBridge.js";
import { ChoiceMachine } from "./choiceMachine.js";

function fakeSocket(): WebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket & { sent: unknown[] };
}

function question(text = "ok?"): ChoiceQuestion {
  return { question: text, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
}

test("presentChoice: publishes a prompt and broadcasts it to every client", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const accepted = machine.presentChoice([question()]);
  assert.equal(accepted, true);
  assert.equal(client.sent.length, 1);
  assert.deepEqual((client.sent[0] as { type: string; kind: string }).type, "choice_prompt");
  assert.deepEqual((client.sent[0] as { kind: string }).kind, "choice");
});

test("presentChoice: a second call while one is already pending is rejected, doesn't touch the first", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.presentChoice([question("first")]);
  const secondAccepted = machine.presentChoice([question("second")]);
  assert.equal(secondAccepted, false);
  // Only one choice_prompt was ever sent — the second call never broadcasts.
  assert.equal(client.sent.length, 1);
});

test("checkPermission: approved answer allows the tool with the original input unchanged", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.checkPermission("Write", { file_path: "/tmp/x" }, undefined);
  // The prompt is now pending as an approval — answer it as "approved".
  const sent = client.sent[0] as { promptId: string; questions: ChoiceQuestion[] };
  machine.answerChoice(sent.promptId, [{ question: sent.questions[0].question, selected: ["approve"] }]);
  const decision = await pending;
  assert.deepEqual(decision, { behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
});

test("checkPermission: a denied ExitPlanMode gets the Plan-mode-specific message", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.checkPermission("ExitPlanMode", {}, undefined);
  const sent = client.sent[0] as { promptId: string; questions: ChoiceQuestion[] };
  machine.answerChoice(sent.promptId, [{ question: sent.questions[0].question, selected: [] }]);
  const decision = await pending;
  assert.deepEqual(decision, { behavior: "deny", message: "O usuário optou por continuar no modo Plan." });
});

test("checkPermission: a denied ordinary tool gets the generic refusal message", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.checkPermission("Bash", { command: "rm -rf /" }, undefined);
  const sent = client.sent[0] as { promptId: string; questions: ChoiceQuestion[] };
  machine.answerChoice(sent.promptId, [{ question: sent.questions[0].question, selected: [] }]);
  const decision = await pending;
  assert.deepEqual(decision, { behavior: "deny", message: "O usuário recusou a execução." });
});

test("cancelPendingApproval: force-resolves a live approval with an empty answer and tells every client it's gone", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.checkPermission("Bash", { command: "echo hi" }, undefined);
  machine.cancelPendingApproval();
  const decision = await pending;
  // An empty answer set is never "approved" — the deny path runs.
  assert.deepEqual(decision, { behavior: "deny", message: "O usuário recusou a execução." });
  const kinds = client.sent.map((m) => (m as { type: string }).type);
  assert.deepEqual(kinds, ["choice_prompt", "choice_resolved"]);
});

test("cancelPendingApproval: a no-op with nothing pending sends nothing", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.cancelPendingApproval();
  assert.deepEqual(client.sent, []);
});

test("cancelPendingApproval: never touches a pending present_choice (pendingChoice survives)", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.presentChoice([question()]);
  machine.cancelPendingApproval();
  // Only the original choice_prompt was sent — no choice_resolved followed,
  // because cancelPendingApproval only ever touches pendingApproval.
  const kinds = client.sent.map((m) => (m as { type: string }).type);
  assert.deepEqual(kinds, ["choice_prompt"]);
});

test("discardStaleChoice: clears a pending present_choice and tells every client it's gone", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.presentChoice([question()]);
  machine.discardStaleChoice();
  const kinds = client.sent.map((m) => (m as { type: string }).type);
  assert.deepEqual(kinds, ["choice_prompt", "choice_resolved"]);
  // Discarded, not answerable anymore.
  const promptId = (client.sent[0] as { promptId: string }).promptId;
  assert.equal(machine.answerChoice(promptId, []).kind, "not_found");
});

test("discardStaleChoice: a no-op with nothing pending sends nothing", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.discardStaleChoice();
  assert.deepEqual(client.sent, []);
});

test("answerChoice: an unknown promptId matches neither slot", () => {
  const machine = new ChoiceMachine(new Set());
  assert.deepEqual(machine.answerChoice("nope", []), { kind: "not_found" });
});

test("answerChoice: a present_choice answer returns kind 'choice' with the answers, and clears the slot", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.presentChoice([question()]);
  const promptId = (client.sent[0] as { promptId: string }).promptId;
  const answers = [{ question: "ok?", selected: ["yes"] }];
  const result = machine.answerChoice(promptId, answers);
  assert.deepEqual(result, { kind: "choice", answers });
  // Second answer to the same (now-cleared) promptId is a no-op.
  assert.deepEqual(machine.answerChoice(promptId, answers), { kind: "not_found" });
});

test("sendPendingTo: sends the deferred choice before the blocking approval, when both are open at once", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.presentChoice([question("deferred")]);
  void machine.checkPermission("Bash", { command: "echo hi" }, undefined);
  const other = fakeSocket();
  machine.sendPendingTo(other);
  const kinds = other.sent.map((m) => (m as { kind: string }).kind);
  assert.deepEqual(kinds, ["choice", "approval"]);
});

test("sendPendingTo: sends nothing to a client when neither slot is open", () => {
  const other = fakeSocket();
  const machine = new ChoiceMachine(new Set());
  machine.sendPendingTo(other);
  assert.deepEqual(other.sent, []);
});
