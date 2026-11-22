import { test } from "node:test";
import assert from "node:assert/strict";
import { botAnswerText, botCancelText, botClockNote, botKickoffText, botScheduleText, parseDelegateTask, parseRememberArgs, parseScheduleCreateArgs, parseTaskAskArgs, parseTaskUpdateArgs } from "./botTools.js";
import { botTurnKind } from "../protocol/botTurns.js";

test("the relay's own turns read back as what they are", () => {
  assert.equal(botTurnKind(botScheduleText("Hourly", "check"))?.kind, "bot_schedule");
  assert.equal(botTurnKind(botAnswerText(2, "q", "a"))?.label, "answer:2");
  assert.equal(botTurnKind(botKickoffText())?.label, "created");
});

test("task_update needs something to change and only takes stored statuses", () => {
  assert.equal(parseTaskUpdateArgs({ task: 1 }).ok, false);
  assert.equal(parseTaskUpdateArgs({ task: 1, status: "needs_you" }).ok, false, "needs_you is derived, never set");
  assert.deepEqual(parseTaskUpdateArgs({ task: "#3", status: "done" }), { ok: true, value: { task: 3, status: "done" } });
});

test("task_ask takes a few options and a recommendation that is one of them", () => {
  assert.equal(parseTaskAskArgs({ task: 1, question: "q", options: [] }).ok, false);
  assert.equal(parseTaskAskArgs({ task: 1, question: "q", options: ["a", "b"], recommended: 2 }).ok, false);
  assert.deepEqual(parseTaskAskArgs({ task: 1, question: " q ", options: [" a ", "b"], recommended: 1 }), { ok: true, value: { task: 1, question: "q", options: ["a", "b"], recommended: 1 } });
});

test("remember takes one of three kinds; schedules collapse spaces in the cron; a delegate's task number is optional", () => {
  assert.equal(parseRememberArgs({ kind: "secret", text: "x" }).ok, false);
  assert.deepEqual(parseRememberArgs({ kind: "rule", text: "never\n merge" }), { ok: true, value: { kind: "rule", text: "never merge" } });
  assert.deepEqual(parseScheduleCreateArgs({ name: "n", cron: "0  9 *  * 1-5", prompt: "p" }), { ok: true, value: { name: "n", cron: "0 9 * * 1-5", prompt: "p" } });
  assert.deepEqual(parseDelegateTask({}), { ok: true, value: undefined });
  assert.equal(parseDelegateTask({ task_number: 0 }).ok, false);
});

test("the cancel note says what came of stopping the task's agents", () => {
  assert.doesNotMatch(botCancelText(2), /stopped|failed/);
  assert.match(botCancelText(2, { stopped: 2, notStopped: [] }), /Its agents were stopped\./);
  const failed = botCancelText(2, { stopped: 1, notStopped: ["w3"] });
  assert.match(failed, /Stopping agent w3 failed: it may still be working\./);
  assert.doesNotMatch(failed, /were stopped/);
  assert.equal(botTurnKind(botCancelText(2))?.kind, "bot_note");
});

test("the clock note gives the time where schedules run, not UTC", () => {
  // 2026-11-22T01:16:00Z is still Saturday evening in São Paulo.
  const note = botClockNote(Date.UTC(2026, 10, 22, 1, 16), "America/Sao_Paulo");
  assert.match(note, /Sat, Nov 21, 2026, 22:16/);
  assert.match(note, /America\/Sao_Paulo/);
});

test("a schedule firing carries its prompt as written, and its header still marks the run", () => {
  const text = botScheduleText("Triage", "List the new issues.");
  assert.doesNotMatch(text, /NO_REPLY/, "staying silent is a standing rule, not part of each run");
  assert.deepEqual(botTurnKind(text), { kind: "bot_schedule", label: "Triage" });
});
