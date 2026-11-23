import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_CHARACTER_TONES, BOT_CLOSED_TASKS_KEPT, cleanBotName, defaultMascot, isBotRecord, pruneTasks, taskStatus, withRun, type BotRecord, type BotTask } from "./bot.js";

const task = (over: Partial<BotTask> = {}): BotTask => ({ n: 1, title: "t", status: "planned", workerIds: [], notes: [], createdAt: 1, updatedAt: 1, ...over });

test("a task needs the person when it has an open question or a worker of it waits for them — unless it is over", () => {
  const none = (): boolean => false;
  assert.equal(taskStatus(task(), none), "planned");
  assert.equal(taskStatus(task({ status: "working", question: { question: "q", options: ["a"], askedAt: 1 } }), none), "needs_you");
  assert.equal(taskStatus(task({ status: "working", workerIds: ["w1", "w2"] }), (id) => id === "w2"), "needs_you");
  assert.equal(taskStatus(task({ status: "done", question: { question: "q", options: ["a"], askedAt: 1 } }), () => true), "done");
  assert.equal(taskStatus(task({ status: "canceled", workerIds: ["w"] }), () => true), "canceled");
});

test("only the oldest closed tasks beyond the limit are dropped; open ones always stay", () => {
  const closed = Array.from({ length: BOT_CLOSED_TASKS_KEPT + 3 }, (_, i) => task({ n: i + 1, status: "done", updatedAt: i }));
  const open = task({ n: 999, status: "working", updatedAt: 0 });
  const kept = pruneTasks([...closed, open]);
  assert.equal(kept.length, BOT_CLOSED_TASKS_KEPT + 1);
  assert.ok(kept.some((each) => each.n === 999));
  assert.ok(!kept.some((each) => each.n === 1 || each.n === 3), "the three oldest closed went");
});

test("runs keep the latest twenty", () => {
  let runs = [] as ReturnType<typeof withRun>;
  for (let i = 0; i < 25; i++) runs = withRun(runs, { at: i, outcome: "silent" });
  assert.equal(runs.length, 20);
  assert.equal(runs[0].at, 5);
});

test("a stored record that does not validate never reaches the bot logic", () => {
  const good: BotRecord = { id: "b", name: "Vigia", mascot: { character: "bip", tone: "sand" }, roomId: "r", paused: false, firstRun: true, createdAt: 1, nextTaskN: 1, tasks: [task()], schedules: [] };
  assert.equal(isBotRecord(good), true);
  assert.equal(isBotRecord({ ...good, tasks: [{ ...task(), status: "needs_you" }] }), false, "needs_you is derived, never stored");
  assert.equal(isBotRecord({ ...good, roomId: "" }), false);
  assert.equal(isBotRecord({ ...good, mascot: { character: "dragon", tone: "sand" } }), false, "an unknown character");
  assert.equal(isBotRecord({ ...good, mascot: { character: "bip", tone: "orange" } }), false, "an unknown tone");
  assert.equal(isBotRecord({ ...good, schedules: [{ id: "s", name: "n", cron: "* * * * *", prompt: "p", paused: false, createdAt: 1, runs: [{ at: 1, outcome: "exploded" }] }] }), false);
});

test("a bot name is one trimmed line, bounded", () => {
  assert.equal(cleanBotName("  Vigia \n do CI "), "Vigia do CI");
  assert.equal(cleanBotName("   "), undefined);
  assert.equal(cleanBotName("x".repeat(41)), undefined);
  assert.equal(cleanBotName(3), undefined);
});

test("a mascot nobody picked comes from the name, in the character's own tone", () => {
  assert.deepEqual(defaultMascot("Vigia"), defaultMascot(" vigia "));
  const mascot = defaultMascot("Vigia");
  assert.equal(mascot.tone, BOT_CHARACTER_TONES[mascot.character]);
});
