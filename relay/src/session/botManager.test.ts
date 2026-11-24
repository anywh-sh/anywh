import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_OPEN_TASKS_MAX, type BotRecord } from "./bot.js";
import { BotManager, type BotSession } from "./botManager.js";
import { BotStore } from "./botStore.js";

type Settle = (outcome: { silenced: boolean; failed: boolean; limited?: boolean }) => void;

/** A bot with one schedule, and a manager whose session keeps each turn's
 * `onSettled` for the test to call (or never call). */
function withBot(
  run: (ctx: { manager: BotManager; store: BotStore; settles: Settle[]; advance: (ms: number) => void; setBusy: (busy: boolean) => void; now: () => number; wake: () => void }) => void,
  firstRun = false,
  extra: { schedulePaused?: boolean; usageResetAt?: (agentId: string) => number | undefined; hostConnected?: () => boolean } = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-botmanager-"));
  try {
    const store = new BotStore(join(dir, "p-bots.json"));
    const bot: BotRecord = {
      id: "b1", name: "CI", mascot: { character: "bip", tone: "sand" }, roomId: "room-b1", paused: false, firstRun, createdAt: 1, nextTaskN: 1, tasks: [],
      schedules: [{ id: "s1", name: "CI check", cron: "0 * * * *", prompt: "Check the CI.", paused: extra.schedulePaused ?? true, createdAt: 1, runs: [] }],
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
    // 2026-11-22 10:30 in São Paulo: the hourly schedule is next due at 11:00.
    let now = Date.parse("2026-11-22T13:30:00Z");
    let timer: (() => void) | undefined;
    const manager = new BotManager({
      store,
      files: {} as never,
      sessionStore: { getAgentId: () => "claude", listRoomMembers: () => [], getPendingChoice: () => undefined, getPendingApproval: () => undefined, getRoom: () => undefined, getTitle: () => null } as never,
      rooms: { agentState: () => undefined } as never,
      sessions: { getOrCreate: () => session, peek: () => session, renameTitle: () => true, deleteSession: () => true },
      runtimes: () => ["claude"],
      hostConnected: extra.hostConnected ?? (() => true),
      now: () => now,
      setTimer: (fn) => {
        timer = fn;
        return () => {};
      },
      timezone: "America/Sao_Paulo",
      ...(extra.usageResetAt ? { usageResetAt: extra.usageResetAt } : {}),
    });
    run({ manager, store, settles, advance: (ms) => (now += ms), setBusy: (value) => (busy = value), now: () => now, wake: () => timer?.() });
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

test("a run that hits a usage limit is neither a failure nor a success, and holds the bot until the plan resets", () => {
  const HOUR = 60 * 60 * 1000;
  let resetAt: number | undefined;
  withBot(
    ({ manager, store, settles, now }) => {
      resetAt = now() + 2 * HOUR;
      assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
      settles[0]({ silenced: false, failed: true, limited: true });
      assert.deepEqual(runs(store), ["limited"]);
      assert.equal(store.get("b1")!.limitedUntil, resetAt, "back when the spent window resets");
    },
    false,
    { usageResetAt: () => resetAt },
  );
  withBot(({ manager, store, settles, now }) => {
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    settles[0]({ silenced: false, failed: true, limited: true });
    assert.equal(store.get("b1")!.limitedUntil, now() + HOUR, "an hour when nobody says when");
    // A turn that goes through ends the limit now.
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    settles[1]({ silenced: false, failed: false });
    assert.equal(store.get("b1")!.limitedUntil, now());
  });
});

test("a turn that goes through before the reset still lets the run the limit held catch up", () => {
  const HOUR = 60 * 60 * 1000;
  withBot(
    ({ manager, store, settles, advance, now, wake }) => {
      manager.start();
      store.update("b1", (bot) => ({ ...bot, limitedUntil: now() + 5 * HOUR }));
      advance(2 * HOUR); // 11:00 came and went while limited, past its grace
      wake();
      assert.equal(settles.length, 0);
      // The person's request goes through: the plan is back early.
      manager.runScheduleNow("b1", "s1");
      settles[0]({ silenced: false, failed: false });
      assert.equal(settles.length, 2, "the held run fires once, instead of being recorded as missed");
      assert.equal(store.get("b1")!.limitedUntil, undefined);
      settles[1]({ silenced: true, failed: false });
      assert.deepEqual(runs(store), ["replied", "silent"]);
      manager.stop();
    },
    false,
    { schedulePaused: false },
  );
});

test("while limited a due schedule waits; once the limit passes it runs once, however late, and the limit clears", () => {
  const HOUR = 60 * 60 * 1000;
  withBot(
    ({ manager, store, settles, advance, now, wake }) => {
      manager.start();
      // A note turn hits the limit for the next three hours.
      store.update("b1", (bot) => ({ ...bot, limitedUntil: now() + 3 * HOUR }));
      advance(HOUR); // past 11:00, when the schedule was due
      wake();
      assert.equal(settles.length, 0, "nothing fires while the plan is spent");
      advance(2 * HOUR); // the limit is over; 11:00 is long past its grace
      wake();
      assert.equal(settles.length, 1, "the held run fires once");
      assert.equal(store.get("b1")!.limitedUntil, undefined);
      settles[0]({ silenced: true, failed: false });
      assert.deepEqual(runs(store), ["silent"], "and no missed run for the hours it covered");
      manager.stop();
    },
    false,
    { schedulePaused: false },
  );
});

test("reading a bot's view never records anything, even with a stale run", () => {
  withBot(({ manager, store, advance }) => {
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    advance(61 * 60 * 1000);
    const view = manager.view("room-b1");
    assert.equal(view?.schedules[0].running, false, "a stale run is not shown as running");
    assert.deepEqual(runs(store), [], "and the view recorded nothing");
  });
});

test("reopening a closed task is refused at the open-task limit, as creating one is", async () => {
  let check: Promise<void> = Promise.resolve();
  withBot(({ manager, store }) => {
    store.update("b1", (bot) => ({
      ...bot,
      nextTaskN: BOT_OPEN_TASKS_MAX + 2,
      tasks: [
        ...Array.from({ length: BOT_OPEN_TASKS_MAX }, (_, i) => ({ n: i + 1, title: `t${String(i + 1)}`, status: "planned" as const, workerIds: [], notes: [], createdAt: 1, updatedAt: 1 })),
        { n: BOT_OPEN_TASKS_MAX + 1, title: "old", status: "done" as const, workerIds: [], notes: [], createdAt: 1, updatedAt: 1 },
      ],
    }));
    check = manager.callTool("room-b1", "task_update", { task: BOT_OPEN_TASKS_MAX + 1, status: "working" })!.then((result) => {
      assert.equal(result.isError, true);
      assert.equal(store.get("b1")!.tasks.find((task) => task.n === BOT_OPEN_TASKS_MAX + 1)!.status, "done");
    });
  });
  await check;
});

test("a room that throws while a bot is created takes the bot and its files back out", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-botmanager-"));
  try {
    const store = new BotStore(join(dir, "p-bots.json"));
    const files: string[] = [];
    const manager = new BotManager({
      store,
      files: { create: (id: string) => files.push(id), remove: (id: string) => files.splice(files.indexOf(id), 1) } as never,
      sessionStore: {} as never,
      rooms: {
        createRoom: () => {
          throw new Error("disk full");
        },
      } as never,
      sessions: {} as never,
      runtimes: () => ["claude"],
      hostConnected: () => true,
      setTimer: () => () => {},
    });
    assert.throws(() => manager.create({ name: "Órfão", soul: "I watch." }), /disk full/);
    assert.deepEqual(store.list(), [], "no bot left without its room");
    assert.deepEqual(files, [], "nor its files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scheduler pass writes each bot once, however many of its schedules it touches", () => {
  withBot(
    ({ manager, store, advance, wake }) => {
      // A second schedule, due at the same time, and a third one paused.
      store.update("b1", (bot) => ({
        ...bot,
        schedules: [...bot.schedules, { id: "s2", name: "Docs", cron: "0 * * * *", prompt: "Docs.", paused: false, createdAt: 1, runs: [] }, { id: "s3", name: "Off", cron: "0 * * * *", prompt: "Off.", paused: true, createdAt: 1, runs: [] }],
      }));
      manager.start();
      advance(3 * 60 * 60 * 1000); // both missed, well past their grace
      let writes = 0;
      const update = store.update.bind(store);
      store.update = (...args: Parameters<BotStore["update"]>) => {
        writes++;
        return update(...args);
      };
      wake();
      assert.equal(writes, 1, "one write for the bot");
      assert.deepEqual(store.get("b1")!.schedules.map((each) => each.runs.map((run) => run.outcome)), [["missed"], ["missed"], []]);
      assert.ok(store.get("b1")!.schedules.slice(0, 2).every((each) => each.nextRunAt !== undefined && each.nextRunAt > Date.parse("2026-11-22T16:30:00Z")));
      manager.stop();
    },
    false,
    { schedulePaused: false },
  );
});

test("a run the limit held still catches up when the agent host was away as the limit ended", () => {
  const HOUR = 60 * 60 * 1000;
  let connected = true;
  withBot(
    ({ manager, store, settles, advance, now, wake }) => {
      manager.start();
      store.update("b1", (bot) => ({ ...bot, limitedUntil: now() + 3 * HOUR }));
      advance(3 * HOUR); // the limit is over; 11:00 is long past its grace
      connected = false;
      wake();
      assert.equal(settles.length, 0, "no host: the run waits");
      assert.notEqual(store.get("b1")!.limitedUntil, undefined, "and the limit stays until it runs");
      advance(30_000);
      connected = true;
      wake();
      assert.equal(settles.length, 1, "the held run fires once the host is back");
      assert.equal(store.get("b1")!.limitedUntil, undefined);
      assert.deepEqual(runs(store), []);
      manager.stop();
    },
    false,
    { schedulePaused: false, hostConnected: () => connected },
  );
});

test("a bot's summary counts its schedules and the last day's runs by how each ended", () => {
  withBot(({ manager, settles, advance }) => {
    const summary = () => manager.summaries()[0];
    assert.equal(summary().scheduleCount, 1, "a paused schedule still counts");
    assert.deepEqual(summary().runs24h, { replied: 0, silent: 0, failed: 0, missed: 0, limited: 0 });
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    settles[0]({ silenced: false, failed: true });
    assert.equal(manager.runScheduleNow("b1", "s1").ok, true);
    settles[1]({ silenced: true, failed: false });
    assert.deepEqual(summary().runs24h, { replied: 0, silent: 1, failed: 1, missed: 0, limited: 0 });
    advance(24 * 60 * 60 * 1000 + 1);
    assert.deepEqual(summary().runs24h, { replied: 0, silent: 0, failed: 0, missed: 0, limited: 0 }, "older runs fall out");
  });
});
