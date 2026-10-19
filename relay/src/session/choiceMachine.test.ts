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

test("presentApprovalChoice: publishes a blocking prompt, resolves with whatever answerChoice sends back", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.presentApprovalChoice([question("approve this?")]);
  const sent = client.sent[0] as { promptId: string; questions: ChoiceQuestion[]; kind: string };
  assert.equal(sent.kind, "approval");
  machine.answerChoice(sent.promptId, [{ question: sent.questions[0].question, selected: ["yes"] }]);
  const answers = await pending;
  assert.deepEqual(answers, [{ question: "approve this?", selected: ["yes"] }]);
});

// checkPermission itself (which builds the ChoiceQuestion/PermissionDecision
// from a tool name — Claude-`--permission-prompt-tool`-shaped) moved to
// SharedSession; its decision-building half is buildPermissionDecision
// (turnMessages.ts, own test coverage there). This class only owns the
// generic slot lifecycle, exercised above.

test("cancelPendingApproval: force-resolves a live approval with an empty answer and tells every client it's gone", async () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  const pending = machine.presentApprovalChoice([question("approve this?")]);
  machine.cancelPendingApproval();
  const answers = await pending;
  assert.deepEqual(answers, []);
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
  void machine.presentApprovalChoice([question("approval")]);
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

test("onPromptShown: fires once per published prompt, for both kinds, and not for a rejected second choice", () => {
  const shown: { kind: string; questions: string[] }[] = [];
  const machine = new ChoiceMachine(new Set(), (kind, questions) => shown.push({ kind, questions: questions.map((q) => q.question) }));

  machine.presentChoice([question("which?")]);
  machine.presentChoice([question("ignored: one is already pending")]);
  void machine.presentApprovalChoice([question("allow?")]);

  assert.deepEqual(shown, [
    { kind: "choice", questions: ["which?"] },
    { kind: "approval", questions: ["allow?"] },
  ]);
});

test("onChoiceChange: reports the pending question when published and undefined once answered", () => {
  const changes: unknown[] = [];
  const machine = new ChoiceMachine(new Set([fakeSocket()]), undefined, undefined, (choice) => changes.push(choice));
  machine.presentChoice([question()]);
  const published = changes[0] as { promptId: string };
  machine.answerChoice(published.promptId, []);
  assert.equal(changes.length, 2);
  assert.equal(changes[1], undefined);
});

test("onChoiceChange: discardStaleChoice reports the slot emptied; a no-op with nothing pending reports nothing", () => {
  const changes: unknown[] = [];
  const machine = new ChoiceMachine(new Set([fakeSocket()]), undefined, undefined, (choice) => changes.push(choice));
  machine.discardStaleChoice();
  assert.deepEqual(changes, []);
  machine.presentChoice([question()]);
  machine.discardStaleChoice();
  assert.equal(changes.length, 2);
  assert.equal(changes[1], undefined);
});

test("initialChoice: a rehydrated question is resent to a connecting socket and can be answered", () => {
  const machine = new ChoiceMachine(new Set(), undefined, { promptId: "p1", questions: [question("again?")] });
  const client = fakeSocket();
  machine.sendPendingTo(client);
  assert.deepEqual((client.sent[0] as { promptId: string }).promptId, "p1");
  assert.equal(machine.answerChoice("p1", []).kind, "choice");
});

test("onChoiceChange throwing (disk full) never breaks present, answer or discard: broadcast and results are unaffected", () => {
  const client = fakeSocket();
  const originalError = console.error;
  console.error = () => {};
  try {
    const machine = new ChoiceMachine(new Set([client]), undefined, undefined, () => {
      throw new Error("ENOSPC");
    });
    assert.equal(machine.presentChoice([question()]), true);
    const promptId = (client.sent[0] as { promptId: string }).promptId;
    assert.equal(machine.answerChoice(promptId, []).kind, "choice");
    assert.equal((client.sent[1] as { type: string }).type, "choice_resolved");

    machine.presentChoice([question()]);
    const second = (client.sent[2] as { promptId: string }).promptId;
    machine.discardStaleChoice();
    assert.deepEqual(client.sent[3], { type: "choice_resolved", promptId: second });
    assert.equal(machine.answerChoice(second, []).kind, "not_found", "the in-memory slot is cleared even though the write failed");
  } finally {
    console.error = originalError;
  }
});

test("a failed CLEAR write is retried once, so an answered question can't come back from disk after a restart", () => {
  const client = fakeSocket();
  const calls: unknown[] = [];
  let failNext = false;
  const machine = new ChoiceMachine(new Set([client]), undefined, undefined, (choice) => {
    if (choice === undefined && failNext) {
      failNext = false;
      throw new Error("EIO");
    }
    calls.push(choice);
  });
  machine.presentChoice([question()]);
  const promptId = (client.sent[0] as { promptId: string }).promptId;
  failNext = true;
  machine.answerChoice(promptId, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], undefined, "the clear must have been written on the retry");
});

test("askedAt: stamped once from the injected clock, broadcast, persisted and identical when resent", () => {
  let clock = 1000;
  const client = fakeSocket();
  const changes: Array<{ askedAt?: number } | undefined> = [];
  const machine = new ChoiceMachine(new Set([client]), undefined, undefined, (c) => changes.push(c), () => clock);
  machine.presentChoice([question()]);
  clock = 9000;
  const late = fakeSocket();
  machine.sendPendingTo(late);
  assert.equal((client.sent[0] as { askedAt: number }).askedAt, 1000);
  assert.equal((late.sent[0] as { askedAt: number }).askedAt, 1000, "a reconnect must not restamp");
  assert.equal(changes[0]?.askedAt, 1000);
});

test("askedAt: survives a restart with the same value (rehydrated from the persisted record, not the new clock)", () => {
  let persisted: { promptId: string; askedAt?: number } | undefined;
  const machine = new ChoiceMachine(new Set(), undefined, undefined, (c) => (persisted = c), () => 1000);
  machine.presentChoice([question()]);
  const restarted = new ChoiceMachine(new Set(), undefined, structuredClone(persisted) as never, undefined, () => 50_000);
  const client = fakeSocket();
  restarted.sendPendingTo(client);
  assert.equal((client.sent[0] as { askedAt: number }).askedAt, 1000);
});

test("askedAt: a record from before the field existed falls back to load time, and that is persisted so it stays stable", () => {
  const changes: Array<{ askedAt?: number } | undefined> = [];
  const machine = new ChoiceMachine(new Set(), undefined, { promptId: "old", questions: [question()] }, (c) => changes.push(c), () => 7000);
  const client = fakeSocket();
  machine.sendPendingTo(client);
  assert.equal((client.sent[0] as { askedAt: number }).askedAt, 7000);
  assert.equal(changes[0]?.askedAt, 7000);
});

test("askedAt: approval prompts carry it too", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]), undefined, undefined, undefined, () => 4242);
  void machine.presentApprovalChoice([question()]);
  assert.equal((client.sent[0] as { askedAt: number }).askedAt, 4242);
});
