import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRecord } from "./bot.js";
import { BotManager, type BotSession } from "./botManager.js";
import { BotStore } from "./botStore.js";

type Settle = (outcome: { silenced: boolean; failed: boolean }) => void;

/** A bot with one schedule, and a manager whose session keeps each turn's
 * `onSettled` for the test to call (or never call). */
function withBot(run: (ctx: { manager: BotManager; store: BotStore; settles: Settle[]; advance: (ms: number) => void; setBusy: (busy: boolean) => void }) => void, firstRun = false): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-botmanager-"));
  try {
    const store = new BotStore(join(dir, "p-bots.json"));
    const bot: BotRecord = {
      id: "b1", name: "CI", mascot: { character: "bip", tone: "areia" }, roomId: "room-b1", paused: false, firstRun, createdAt: 1, nextTaskN: 1, tasks: [],
      schedules: [{ id: "s1", name: "CI check", cron: "0 * * * *", prompt: "Check the CI.", paused: true, createdAt: 1, runs: [] }],
    };
    store.put(bot);
    const settles: Settle[] = [];
    let busy = false;
    const session: BotSession = {
      submitBotTurn: (_text, turn) => {
        settles.push((outcome) => turn.onSettled?.(outcome));
      },
      isBusy: () => busy,
      isAnyoneLooking: () => false,
    };
    let now = 1_000_000;
    const manager = new BotManager({
      store,
      files: {} as never,
      sessionStore: {} as never,
      rooms: {} as never,
      sessions: { getOrCreate: () => session, peek: () => session, renameTitle: () => true, deleteSession: () => true },
      runtimes: () => ["claude"],
      hostConnected: () => true,
      now: () => now,
      setTimer: () => () => {},
      timezone: "America/Sao_Paulo",
    });
    run({ manager, store, settles, advance: (ms) => (now += ms), setBusy: (value) => (busy = value) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runs = (store: BotStore) => store.get("b1")!.schedules[0].runs.map((each) => each.outcome);

test("Run now is refused while a run is under way, and allowed again once it settles", () => {
  withBot(({ manager, store, settles }) => {
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    const second = manager.runScheduleNow("b1", "s1");
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.status, 409);
    settles[0]({ silenced: true, failed: false });
    assert.deepEqual(runs(store), ["silent"]);
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
  });
});

test("a run whose end never comes is taken as failed after an hour with the bot idle, and its late end changes nothing", () => {
  withBot(({ manager, store, settles, advance, setBusy }) => {
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    advance(61 * 60 * 1000);
    setBusy(true);
    assert.equal(manager.runScheduleNow("b1", "s1").ok, false, "still running while the bot works");
    setBusy(false);
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true, "stale and idle: a new run starts");
    assert.deepEqual(runs(store), ["failed"], "the stale run is recorded as failed");
    settles[0]({ silenced: false, failed: false });
    assert.deepEqual(runs(store), ["failed"], "the stale run's late end is ignored");
    assert.equal(manager.runScheduleNow("b1", "s1").ok, false, "and does not free the new run's slot");
    settles[1]({ silenced: false, failed: false });
    assert.deepEqual(runs(store), ["failed", "replied"]);
  });
});

test("every turn of a bot tells it the time where its schedules run; the first conversation adds its note", () => {
  withBot(({ manager }) => {
    const note = manager.turnNote("room-b1");
    assert.match(note ?? "", /America\/Sao_Paulo/);
    assert.doesNotMatch(note ?? "", /first conversation/);
    assert.equal(manager.turnNote("room-nobody"), undefined);
  });
  withBot(({ manager }) => {
    const note = manager.turnNote("room-b1") ?? "";
    assert.match(note, /first conversation/);
    assert.match(note, /language the person writes to you in/);
    assert.match(note, /America\/Sao_Paulo/);
  }, true);
});
