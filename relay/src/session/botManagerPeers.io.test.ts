import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botTurnKind } from "../protocol/botTurns.js";
import type { BotRecord } from "./bot.js";
import { BotManager, type BotSession } from "./botManager.js";
import { BOT_PEER_SENDS_PER_HOUR } from "./botPeers.js";
import { BotStore } from "./botStore.js";
import type { BotTurnOutcome } from "./sharedSession.js";

/** A turn the relay gave a bot, with its end for the test to call. */
interface Turn {
  roomId: string;
  text: string;
  label: string;
  settle: (outcome: BotTurnOutcome) => void;
}

const record = (id: string, name: string, createdAt: number): BotRecord => ({
  id,
  name,
  mascot: { character: "bip", tone: "sand" },
  roomId: `room-${id}`,
  paused: false,
  firstRun: false,
  createdAt,
  nextTaskN: 1,
  tasks: [],
  schedules: [],
});

/** Two bots, Ana and Bruno, on a real bots file, with sessions that keep
 * every relay turn for the test. */
function withPeers(run: (ctx: { manager: BotManager; store: BotStore; turns: Turn[]; call: (botId: string, name: string, args: unknown) => Promise<{ text: string; isError: boolean }>; advance: (ms: number) => void; path: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-botpeers-"));
  const path = join(dir, "p-bots.json");
  const store = new BotStore(path);
  store.put(record("ana", "Ana", 1));
  store.put(record("bruno", "Bruno", 2));
  const turns: Turn[] = [];
  const session = (roomId: string): BotSession => ({
    submitBotTurn: (text, turn) => {
      turns.push({ roomId, text, label: turn.label, settle: (outcome) => turn.onSettled?.(outcome) });
    },
    isBusy: () => roomId === "room-bruno",
    isAnyoneLooking: () => false,
  });
  let now = Date.parse("2026-11-24T13:30:00Z");
  const souls: Record<string, string> = { ana: "# Ana\n\nI write the daily summary.", bruno: "I watch releases and say what shipped." };
  const manager = new BotManager({
    store,
    files: { readSoul: (id: string) => souls[id] ?? "", remove: () => undefined } as never,
    sessionStore: { getAgentId: () => "claude", listRoomMembers: () => [], getPendingChoice: () => undefined, getPendingApproval: () => undefined, getRoom: () => undefined, getTitle: () => null } as never,
    rooms: { agentState: () => undefined, stopAgent: () => Promise.resolve({ ok: true }) } as never,
    sessions: { getOrCreate: session, peek: session, renameTitle: () => true, deleteSession: () => true },
    runtimes: () => ["claude"],
    hostConnected: () => true,
    now: () => now,
    setTimer: () => () => {},
    timezone: "America/Sao_Paulo",
  });
  const call = async (botId: string, name: string, args: unknown) => (await manager.callTool(`room-${botId}`, name, args))!;
  return run({ manager, store, turns, call, advance: (ms) => (now += ms), path }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("bot_list shows the other bots, what each is for and whether it is busy, never the asker", async () => {
  await withPeers(async ({ call }) => {
    const result = await call("ana", "bot_list", {});
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.text), { bots: [{ name: "Bruno", id: "bruno", purpose: "I watch releases and say what shipped.", busy: true }] });
  });
});

test("every turn of a bot names the other bots, never itself", async () => {
  await withPeers(({ manager }) => {
    const note = manager.turnNote("room-ana")!;
    assert.match(note, /- Bruno: I watch releases and say what shipped\./);
    assert.doesNotMatch(note, /- Ana:/);
    return Promise.resolve();
  });
});

test("a question reaches the other bot as a relay turn, and its reply comes back to the asker as the answer", async () => {
  await withPeers(async ({ call, turns, store }) => {
    store.update("ana", (bot) => ({ ...bot, nextTaskN: 2, tasks: [{ n: 1, title: "Daily summary", status: "working", workerIds: [], notes: [], createdAt: 1, updatedAt: 1 }] }));
    const sent = await call("ana", "bot_ask", { to: "bruno", question: "What shipped yesterday?", task: 1 });
    assert.equal(sent.isError, false);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].roomId, "room-bruno");
    assert.deepEqual(botTurnKind(turns[0].text), { kind: "bot_note", label: "peer_ask:Ana" });
    assert.equal(turns[0].label, "peer_ask:Ana");
    assert.match(store.get("ana")!.tasks[0].notes[0].text, /^Asked Bruno: What shipped/);

    const again = await call("ana", "bot_ask", { to: "Bruno", question: "And today?" });
    assert.equal(again.isError, true, "one open question per pair");
    assert.equal(turns.length, 1);

    turns[0].settle({ silenced: false, failed: false, reply: "v0.2.90 and v0.2.91." });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].roomId, "room-ana");
    assert.equal(turns[1].label, "peer_answer:Bruno");
    assert.match(turns[1].text, /Answer: v0\.2\.90 and v0\.2\.91\./);
    assert.match(turns[1].text, /Question: What shipped yesterday\?/);

    assert.equal((await call("ana", "bot_ask", { to: "Bruno", question: "And today?" })).isError, false, "the pair is free again");
  });
});

test("a question whose turn fails, stops or says nothing comes back as no answer", async () => {
  await withPeers(async ({ call, turns }) => {
    const outcomes: BotTurnOutcome[] = [{ silenced: false, failed: true }, { silenced: false, failed: false, stopped: true, reply: "partial" }, { silenced: false, failed: false, reply: "  " }];
    for (const outcome of outcomes) {
      await call("ana", "bot_ask", { to: "Bruno", question: "q" });
      turns.at(-1)!.settle(outcome);
      assert.equal(turns.at(-1)!.label, "peer_noanswer:Bruno");
      assert.equal(turns.at(-1)!.roomId, "room-ana");
    }
    assert.match(turns[1].text, /its turn failed/);
    assert.match(turns[3].text, /its turn was stopped/);
    assert.match(turns[5].text, /replied with nothing/);
  });
});

test("an answer to a bot deleted meanwhile goes nowhere", async () => {
  await withPeers(async ({ call, turns, manager }) => {
    await call("ana", "bot_ask", { to: "Bruno", question: "q" });
    manager.remove("ana");
    turns[0].settle({ silenced: false, failed: false, reply: "a" });
    assert.equal(turns.length, 1);
  });
});

test("a bot cannot message itself, an unknown bot, or for a task of its own that is not open", async () => {
  await withPeers(async ({ call, turns }) => {
    assert.equal((await call("ana", "bot_ask", { to: "Ana", question: "q" })).isError, true);
    assert.equal((await call("ana", "bot_ask", { to: "Carla", question: "q" })).isError, true);
    assert.equal((await call("ana", "bot_handoff", { to: "Bruno", title: "t", details: "d", task: 9 })).isError, true);
    assert.equal(turns.length, 0);
  });
});

test("a bot sends at most so many messages to other bots an hour", async () => {
  await withPeers(async ({ call, turns, advance }) => {
    for (let i = 0; i < BOT_PEER_SENDS_PER_HOUR; i++) assert.equal((await call("ana", "bot_handoff", { to: "Bruno", title: `t${i}`, details: "d" })).isError, false);
    const over = await call("ana", "bot_handoff", { to: "Bruno", title: "one more", details: "d" });
    assert.equal(over.isError, true);
    assert.match(over.text, /in the last hour/);
    assert.equal(turns.length, BOT_PEER_SENDS_PER_HOUR);
    advance(60 * 60 * 1000);
    assert.equal((await call("ana", "bot_handoff", { to: "Bruno", title: "later", details: "d" })).isError, false);
  });
});

test("a hand-off becomes a task of the other bot, kept with where it came from, and its closing is told to the sender", async () => {
  await withPeers(async ({ call, turns, store, manager, path }) => {
    store.update("ana", (bot) => ({ ...bot, nextTaskN: 4, tasks: [{ n: 3, title: "CI check", status: "working", workerIds: [], notes: [], createdAt: 1, updatedAt: 1 }] }));
    const handed = await call("ana", "bot_handoff", { to: "Bruno", title: "Fix the flaky test", details: "wakeup.test.ts fails on CI, see PR #300.", task: 3 });
    assert.equal(handed.isError, false);
    const task = store.get("bruno")!.tasks[0];
    assert.equal(task.n, 1);
    assert.equal(task.status, "planned");
    assert.deepEqual(task.from, { botId: "ana", taskN: 3 });
    assert.match(task.notes[0].text, /^From Ana: wakeup\.test\.ts/);
    assert.equal(turns[0].roomId, "room-bruno");
    assert.equal(turns[0].label, "peer_handoff:1:Ana");
    assert.deepEqual(manager.view("room-bruno")!.tasks[0].from, { botId: "ana", name: "Ana" });

    // Kept on disk with its origin.
    assert.deepEqual(new BotStore(path).get("bruno")!.tasks[0].from, { botId: "ana", taskN: 3 });

    await call("bruno", "task_update", { task: 1, status: "working" });
    assert.equal(turns.length, 1, "only closing is told");
    await call("bruno", "task_update", { task: 1, status: "done", note: "Fixed in PR #301." });
    assert.equal(turns.length, 2);
    assert.equal(turns[1].roomId, "room-ana");
    assert.equal(turns[1].label, "peer_closed:1:Bruno");
    assert.match(turns[1].text, /: done\./);
    assert.match(turns[1].text, /your task #3/);
    assert.match(turns[1].text, /Last note: Fixed in PR #301\./);
    assert.match(store.get("ana")!.tasks[0].notes.at(-1)!.text, /Bruno closed #1: done/);

    await call("bruno", "task_update", { task: 1, status: "done" });
    assert.equal(turns.length, 2, "closing a closed task again tells nobody");
  });
});

test("the person canceling a handed-off task tells the sender too; with the sender gone nobody is told", async () => {
  await withPeers(async ({ call, turns, manager }) => {
    await call("ana", "bot_handoff", { to: "Bruno", title: "t1", details: "d" });
    await call("ana", "bot_handoff", { to: "Bruno", title: "t2", details: "d" });
    assert.equal(manager.cancelTask("bruno", 1).ok, true);
    const told = turns.filter((turn) => turn.roomId === "room-ana");
    assert.equal(told.length, 1);
    assert.match(told[0].text, /canceled \(by the person\)/);
    manager.remove("ana");
    await call("bruno", "task_update", { task: 2, status: "done" });
    assert.equal(turns.filter((turn) => turn.roomId === "room-ana").length, 1);
  });
});
