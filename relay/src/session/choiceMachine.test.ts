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
  machine.discardStaleChoice(1);
  const kinds = client.sent.map((m) => (m as { type: string }).type);
  assert.deepEqual(kinds, ["choice_prompt", "choice_resolved"]);
  // Discarded, not answerable anymore.
  const promptId = (client.sent[0] as { promptId: string }).promptId;
  assert.equal(machine.answerChoice(promptId, []).kind, "not_found");
});

test("discardStaleChoice: a no-op with nothing pending sends nothing", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]));
  machine.discardStaleChoice(1);
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
  machine.discardStaleChoice(1);
  assert.deepEqual(changes, []);
  machine.presentChoice([question()]);
  machine.discardStaleChoice(1);
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
    machine.discardStaleChoice(1);
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

test("askedAt: a record from before the field existed stays undefined: omitted on the wire, nothing written", () => {
  const changes: unknown[] = [];
  const machine = new ChoiceMachine(new Set(), undefined, { promptId: "old", questions: [question()] }, (c) => changes.push(c), () => 7000);
  const client = fakeSocket();
  machine.sendPendingTo(client);
  assert.equal("askedAt" in (client.sent[0] as object), false);
  assert.deepEqual(changes, []);
});

test("askedAt: approval prompts carry it too", () => {
  const client = fakeSocket();
  const machine = new ChoiceMachine(new Set([client]), undefined, undefined, undefined, () => 4242);
  void machine.presentApprovalChoice([question()]);
  assert.equal((client.sent[0] as { askedAt: number }).askedAt, 4242);
});

// --- deferred tool approval -------------------------------------------------

type Sent = { type: string; promptId: string; kind?: string; askedAt?: number; questions?: ChoiceQuestion[] };

function machineWithClock(
  client: ReturnType<typeof fakeSocket>,
  opts: { initial?: import("./sessionStore.js").PersistedApproval; initialChoice?: import("./sessionStore.js").PersistedChoice; initialQueued?: import("./sessionStore.js").PersistedApproval; withdrawn?: boolean } = {},
) {
  const clock = { now: 1_000_000 };
  const stored: Array<import("./sessionStore.js").PersistedApproval | undefined> = [];
  const storedChoice: Array<import("./sessionStore.js").PersistedChoice | undefined> = [];
  const shown: string[] = [];
  const storedQueued: Array<import("./sessionStore.js").PersistedApproval | undefined> = [];
  const storedWithdrawn: boolean[] = [];
  const machine = new ChoiceMachine(
    new Set([client]),
    (kind) => shown.push(kind),
    opts.initialChoice,
    (choice) => storedChoice.push(choice),
    () => clock.now,
    {
      initial: opts.initial,
      onChange: (approval) => stored.push(approval),
      initialQueued: opts.initialQueued,
      onQueuedChange: (approval) => storedQueued.push(approval),
      initialWithdrawn: opts.withdrawn,
      onWithdrawnChange: (value) => storedWithdrawn.push(value),
    },
  );
  return { machine, clock, stored, storedChoice, storedQueued, storedWithdrawn, shown };
}

const WRITE = { tool: "Write", input: { file_path: "/tmp/a", content: "x" }, toolUseId: "toolu_1" };
const BASH = { tool: "Bash", input: { command: "ls" }, toolUseId: "toolu_2", agentId: "sub-1" };
const THIRD = { tool: "Edit", input: { file_path: "/tmp/b" }, toolUseId: "toolu_3" };

test("deferApproval: nothing is published or persisted until the turn's calls are flushed, then ONE prompt covers them all", () => {
  const client = fakeSocket();
  const { machine, clock, stored, shown } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  clock.now += 5_000;
  machine.deferApproval(BASH, question("bash?"), 1);
  machine.deferApproval(THIRD, question("edit?"), 1);
  assert.deepEqual(client.sent, [], "calls arrive during the turn; the card must not move under the person's hands");
  assert.equal(stored.length, 0);

  machine.flushDeferredApprovals(1);
  const sent = client.sent as Sent[];
  assert.deepEqual(sent.map((m) => m.type), ["choice_prompt"], "published exactly once");
  assert.equal(sent[0].kind, "approval");
  assert.equal(sent[0].askedAt, 1_005_000);
  assert.deepEqual(sent[0].questions?.map((q) => q.question), ["write?", "bash?", "edit?"]);
  assert.deepEqual(stored.at(-1)?.calls, [WRITE, BASH, THIRD]);
  assert.deepEqual(shown, ["approval"]);
  machine.cancelPendingApproval();
  assert.equal(client.sent.length, 1, "cancelPendingApproval must not touch a deferred approval");
});

test("deferApproval: a call with a toolUseId already held (staged or published) is ignored", () => {
  const client = fakeSocket();
  const { machine, stored } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.deferApproval({ ...WRITE }, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  machine.deferApproval({ ...WRITE }, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  assert.equal(client.sent.length, 1);
  assert.equal(stored.at(-1)?.calls.length, 1);
});

test("a call that arrives while the card is on screen waits for the next cycle, under a new prompt, once the first is answered", () => {
  const client = fakeSocket();
  const { machine } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  const first = client.sent[0] as Sent;
  machine.deferApproval(BASH, question("bash?"), 1);
  machine.flushDeferredApprovals(1);
  assert.equal(client.sent.length, 1, "the card on screen is not touched");

  machine.answerChoice(first.promptId, [{ question: "write?", selected: ["yes"] }]);
  const types = (client.sent as Sent[]).map((m) => m.type);
  assert.deepEqual(types, ["choice_prompt", "choice_resolved", "choice_prompt"]);
  const second = client.sent[2] as Sent;
  assert.notEqual(second.promptId, first.promptId);
  assert.deepEqual(second.questions?.map((q) => q.question), ["bash?"]);
});

test("answerChoice on a deferred approval: hands back the calls and answers, clears the slot and the stored copy", () => {
  const client = fakeSocket();
  const { machine, clock, stored } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.deferApproval(BASH, question("bash?"), 1);
  machine.flushDeferredApprovals(1);
  const prompt = (client.sent as Sent[]).at(-1)!;
  // Answered six hours later: nothing in the machine depends on elapsed time.
  clock.now += 6 * 60 * 60 * 1000;
  const answers = [{ question: "write?", selected: ["yes"] }, { question: "bash?", selected: ["no"] }];
  const result = machine.answerChoice(prompt.promptId, answers);
  assert.deepEqual(result, { kind: "deferredApproval", calls: [WRITE, BASH], questions: [question("write?"), question("bash?")], answers, waiting: [] });
  assert.equal(stored.at(-1), undefined);
  assert.equal((client.sent.at(-1) as Sent).type, "choice_resolved");
  assert.deepEqual(machine.answerChoice(prompt.promptId, answers), { kind: "not_found" }, "first answer wins");
});

test("discardStaleChoice: a human who moves on dismisses a deferred approval too, and says whether there was one", () => {
  const client = fakeSocket();
  const { machine, stored } = machineWithClock(client);
  assert.equal(machine.discardStaleChoice(0), false);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  assert.equal(machine.discardStaleChoice(1), true);
  assert.equal((client.sent.at(-1) as Sent).type, "choice_resolved");
  assert.equal(stored.at(-1), undefined);
});

test("a rehydrated deferred approval is sent to a reconnecting socket, and dropRehydrated clears it silently", () => {
  const first = fakeSocket();
  const { machine } = machineWithClock(first);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  const persisted = { promptId: (first.sent[0] as Sent).promptId, questions: [question("write?")], calls: [WRITE], askedAt: 1_000_000 };

  const late = fakeSocket();
  const reborn = machineWithClock(fakeSocket(), { initial: persisted });
  reborn.machine.sendPendingTo(late);
  assert.deepEqual(late.sent, [{ type: "choice_prompt", promptId: persisted.promptId, questions: persisted.questions, kind: "approval", askedAt: 1_000_000 }]);
  assert.equal(reborn.shown.length, 0, "no new notification for a rehydrated prompt");

  reborn.machine.dropRehydrated();
  assert.equal(reborn.stored.at(-1), undefined);
  const after = fakeSocket();
  reborn.machine.sendPendingTo(after);
  assert.deepEqual(after.sent, []);
});

test("only one card at a time: an approval flushed while a question is on screen is persisted but held back, and appears when the question is answered", () => {
  const client = fakeSocket();
  const { machine, stored } = machineWithClock(client);
  machine.presentChoice([question("which?")]);
  const choice = client.sent[0] as Sent;
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  assert.deepEqual((client.sent as Sent[]).map((m) => m.type), ["choice_prompt"], "the approval does not cover the question");
  assert.equal(stored.at(-1)?.calls.length, 1, "but it is already persisted");
  const late = fakeSocket();
  machine.sendPendingTo(late);
  assert.deepEqual((late.sent as Sent[]).map((m) => m.kind), ["choice"], "a reconnecting device sees one card");

  machine.answerChoice(choice.promptId, [{ question: "which?", selected: ["a"] }]);
  assert.deepEqual((client.sent as Sent[]).map((m) => m.type), ["choice_prompt", "choice_resolved", "choice_prompt"]);
  assert.equal((client.sent[2] as Sent).kind, "approval");
});

test("only one card at a time: a question asked while an approval is on screen is persisted but held back, and appears when the approval is answered", () => {
  const client = fakeSocket();
  const { machine, storedChoice, shown } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  const approval = client.sent[0] as Sent;
  assert.equal(machine.presentChoice([question("which?")]), true);
  assert.deepEqual((client.sent as Sent[]).map((m) => m.type), ["choice_prompt"]);
  assert.equal(storedChoice.length, 1, "persisted already");

  machine.answerChoice(approval.promptId, [{ question: "write?", selected: ["yes"] }]);
  assert.deepEqual((client.sent as Sent[]).map((m) => m.kind ?? m.type), ["approval", "choice_resolved", "choice"]);
  assert.deepEqual(shown, ["approval", "choice"], "each card notifies when it appears");
});

test("a restart with both a question and an approval stored shows the question only; the approval follows its answer", () => {
  const choice = { promptId: "c1", questions: [question("which?")], askedAt: 1 };
  const approval = { promptId: "a1", questions: [question("write?")], calls: [WRITE], askedAt: 2 };
  const client = fakeSocket();
  const { machine } = machineWithClock(client, { initial: approval, initialChoice: choice });
  const socket = fakeSocket();
  machine.sendPendingTo(socket);
  assert.deepEqual((socket.sent as Sent[]).map((m) => m.promptId), ["c1"]);
  machine.answerChoice("c1", [{ question: "which?", selected: ["a"] }]);
  assert.deepEqual((client.sent as Sent[]).map((m) => m.promptId), ["c1", "a1"]);
});

test("calls that wait behind a card on screen are persisted, survive a restart, and become the next card", () => {
  const client = fakeSocket();
  const first = machineWithClock(client);
  first.machine.deferApproval(WRITE, question("write?"), 1);
  first.machine.flushDeferredApprovals(1);
  first.machine.deferApproval(BASH, question("bash?"), 2);
  first.machine.flushDeferredApprovals(2);
  assert.equal(client.sent.length, 1, "the card on screen is untouched");
  const queued = first.storedQueued.at(-1);
  assert.deepEqual(queued?.calls, [BASH], "what waits is on disk, not only in memory");

  // Restart: the card on screen and the queue come back from disk.
  const shownCard = (client.sent[0] as Sent);
  const second = machineWithClock(fakeSocket(), { initial: { promptId: shownCard.promptId, questions: [question("write?")], calls: [WRITE], askedAt: 1_000_000 }, initialQueued: queued });
  const reconnected = fakeSocket();
  second.machine.sendPendingTo(reconnected);
  assert.deepEqual((reconnected.sent as Sent[]).map((m) => m.promptId), [shownCard.promptId]);
  const sock = fakeSocket();
  const third = machineWithClock(sock, { initial: { promptId: "p1", questions: [question("write?")], calls: [WRITE], askedAt: 1 }, initialQueued: queued });
  third.machine.answerChoice("p1", [{ question: "write?", selected: ["yes"] }]);
  const next = (sock.sent as Sent[]).find((m) => m.type === "choice_prompt");
  assert.deepEqual(next?.questions?.map((q) => q.question), ["bash?"]);
  assert.equal(third.storedQueued.at(-1), undefined, "the queue is emptied once it is the card");
});

test("an interrupted turn drops only ITS refusals; another turn's staged calls and the queue stay", () => {
  const client = fakeSocket();
  const { machine, storedWithdrawn } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.deferApproval(BASH, question("bash?"), 2);
  assert.equal(machine.dropStagedApprovals(2), true, "something was dropped");
  assert.deepEqual(storedWithdrawn, [true], "the model heard 'wait', so the next message must say it was withdrawn");
  machine.flushDeferredApprovals(1);
  assert.deepEqual((client.sent[0] as Sent).questions?.map((q) => q.question), ["write?"]);
  assert.equal(machine.dropStagedApprovals(9), false);
});

test("a message that arrives mid-turn withdraws that turn's refusals even when they come after it", () => {
  const client = fakeSocket();
  const { machine } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 3);
  assert.equal(machine.discardStaleChoice(3), true, "a staged refusal counts as a pending approval to withdraw");
  machine.deferApproval(BASH, question("bash?"), 3);
  machine.flushDeferredApprovals(3);
  assert.deepEqual(client.sent, [], "turn 3 started before the person moved on: nothing from it is asked");
  machine.deferApproval(BASH, question("bash?"), 4);
  machine.flushDeferredApprovals(4);
  assert.equal(client.sent.length, 1, "a later turn is unaffected");
});

test("takeWithdrawn reports and clears the persisted flag once", () => {
  const { machine, storedWithdrawn } = machineWithClock(fakeSocket(), { withdrawn: true });
  assert.equal(machine.takeWithdrawn(), true);
  assert.equal(machine.takeWithdrawn(), false);
  assert.deepEqual(storedWithdrawn, [false]);
});

test("a refusal that arrives after the person moved on is withdrawn, and the model is owed the note", () => {
  const client = fakeSocket();
  const { machine, storedWithdrawn } = machineWithClock(client);
  machine.discardStaleChoice(3);
  machine.deferApproval(WRITE, question("write?"), 3);
  assert.deepEqual(storedWithdrawn, [true]);
  assert.equal(machine.takeWithdrawn(), true);
});

test("calls waiting behind the card promoted at construction are mirrored, so an answered card does not come back after a restart", () => {
  const queued = { promptId: "q1", questions: [question("bash?")], calls: [BASH], askedAt: 5 };
  const { machine, stored, storedQueued } = machineWithClock(fakeSocket(), { initialQueued: queued });
  assert.deepEqual(stored.at(-1), queued, "the promoted card is written as the pending approval");
  assert.equal(storedQueued.at(-1), undefined, "and the queue slot is emptied on disk");
  machine.answerChoice("q1", [{ question: "bash?", selected: ["yes"] }]);
  assert.equal(stored.at(-1), undefined);
});

test("answering reports the calls still waiting for an answer (queued behind this card, or staged by a running turn)", () => {
  const client = fakeSocket();
  const { machine } = machineWithClock(client);
  machine.deferApproval(WRITE, question("write?"), 1);
  machine.flushDeferredApprovals(1);
  machine.deferApproval(BASH, question("bash?"), 2);
  machine.flushDeferredApprovals(2);
  machine.deferApproval(THIRD, question("edit?"), 3);
  const result = machine.answerChoice((client.sent[0] as Sent).promptId, [{ question: "write?", selected: ["yes"] }]);
  assert.equal(result.kind, "deferredApproval");
  if (result.kind === "deferredApproval") assert.deepEqual(result.waiting, [BASH, THIRD]);
});

test("markWithdrawn records an approval the model was not told about", () => {
  const { machine, storedWithdrawn } = machineWithClock(fakeSocket());
  machine.markWithdrawn();
  assert.deepEqual(storedWithdrawn, [true]);
});
