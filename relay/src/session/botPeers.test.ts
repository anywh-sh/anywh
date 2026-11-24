import { test } from "node:test";
import assert from "node:assert/strict";
import { botTurnKind } from "../protocol/botTurns.js";
import type { BotRecord } from "./bot.js";
import {
  BOT_PEER_PURPOSE_MAX,
  BOT_PEER_REPLY_MAX,
  BOT_PEER_SENDS_PER_HOUR,
  BOT_PEER_WINDOW_MS,
  parseBotAskArgs,
  parseBotHandoffArgs,
  peerAnswerText,
  peerAskText,
  peerClosedText,
  peerHandoffText,
  peerNoAnswerText,
  peerPurpose,
  resolvePeer,
  sendWindow,
} from "./botPeers.js";
import { BOT_TOOLS, botInstructions } from "./botTools.js";

const bot = (id: string, name: string): BotRecord => ({ id, name, mascot: { character: "bip", tone: "sand" }, roomId: `room-${id}`, paused: false, firstRun: false, createdAt: 1, nextTaskN: 1, tasks: [], schedules: [] });

test("a peer is found by id or by name in any case, never the asker, and a shared name asks for the id", () => {
  const bots = [bot("a", "Ana"), bot("b", "Bruno"), bot("c1", "Twin"), bot("c2", "twin")];
  const byName = resolvePeer(bots, "a", "bruno");
  assert.equal(byName.ok && byName.value.id, "b");
  const byId = resolvePeer(bots, "a", "c2");
  assert.equal(byId.ok && byId.value.id, "c2");
  const twin = resolvePeer(bots, "a", "Twin");
  assert.equal(twin.ok, false);
  assert.match(!twin.ok ? twin.error : "", /c1, c2/);
  assert.equal(resolvePeer(bots, "a", "ana").ok, false, "by name, itself");
  assert.equal(resolvePeer(bots, "a", "a").ok, false, "by id, itself");
  assert.match((resolvePeer(bots, "a", "Nobody") as { error: string }).error, /bot_list/);
});

test("what a peer is for is its soul's first paragraph that is not a heading, on one line and bounded", () => {
  assert.equal(peerPurpose(""), null);
  assert.equal(peerPurpose("# Release bot\n\nI watch releases\nand tell you.\n\n## How I work\n- a"), "I watch releases and tell you.");
  const long = peerPurpose("x".repeat(500))!;
  assert.equal(long.length, BOT_PEER_PURPOSE_MAX);
  assert.ok(long.endsWith("…"));
});

test("a bot sends at most so many messages an hour, counted over a sliding window", () => {
  const now = 10 * BOT_PEER_WINDOW_MS;
  const full = Array.from({ length: BOT_PEER_SENDS_PER_HOUR }, (_, i) => now - i * 1000);
  assert.equal(sendWindow(full, now).allowed, false);
  const aged = [now - BOT_PEER_WINDOW_MS, ...full.slice(1)];
  const window = sendWindow(aged, now);
  assert.equal(window.allowed, true, "the oldest left the window");
  assert.equal(window.recent.length, BOT_PEER_SENDS_PER_HOUR - 1);
});

test("every peer message reads back as its own kind of relay turn, with the bot's name, quotes included", () => {
  assert.deepEqual(botTurnKind(peerAskText('Ana "the" bot', "Did it ship?")), { kind: "bot_note", label: 'peer_ask:Ana "the" bot' });
  assert.deepEqual(botTurnKind(peerAnswerText("Bruno", "Did it ship?", "Yes.")), { kind: "bot_note", label: "peer_answer:Bruno" });
  assert.deepEqual(botTurnKind(peerNoAnswerText("Bruno", "Did it ship?", "failed")), { kind: "bot_note", label: "peer_noanswer:Bruno" });
  assert.deepEqual(botTurnKind(peerHandoffText("Ana", 12, "Fix the flaky test", "See #300.")), { kind: "bot_note", label: "peer_handoff:12:Ana" });
  assert.deepEqual(botTurnKind(peerClosedText("Bruno", { n: 12, title: "Fix it", status: "done", byPerson: false })), { kind: "bot_note", label: "peer_closed:12:Bruno" });
});

test("a peer's message says it is not the person's, and a long answer is cut", () => {
  assert.match(peerAskText("Ana", "q"), /not from the person/);
  assert.match(peerAskText("Ana", "q"), /never an approval/);
  assert.match(peerHandoffText("Ana", 3, "t", "d"), /task_number 3/);
  assert.match(peerAnswerText("Bruno", "q", "a"), /not instructions from the person/);
  const cut = peerAnswerText("Bruno", "q", "y".repeat(BOT_PEER_REPLY_MAX + 50));
  assert.ok(!cut.includes("y".repeat(BOT_PEER_REPLY_MAX + 1)));
  const closed = peerClosedText("Bruno", { n: 4, title: "t", status: "canceled", byPerson: true, forTaskN: 2, note: "Not needed." });
  assert.match(closed, /canceled \(by the person\)/);
  assert.match(closed, /your task #2/);
  assert.match(closed, /Last note: Not needed\./);
});

test("bot_ask and bot_handoff need a peer and the text; the sender's own task is optional", () => {
  assert.equal(parseBotAskArgs({ question: "q" }).ok, false);
  assert.equal(parseBotAskArgs({ to: "Bruno" }).ok, false);
  assert.deepEqual(parseBotAskArgs({ to: " Bruno ", question: " q ", task: "#3" }), { ok: true, value: { to: "Bruno", question: "q", task: 3 } });
  assert.equal(parseBotAskArgs({ to: "Bruno", question: "q", task: 0 }).ok, false);
  assert.equal(parseBotHandoffArgs({ to: "Bruno", title: "t" }).ok, false);
  assert.deepEqual(parseBotHandoffArgs({ to: "Bruno", title: "Fix\n the  test", details: "d" }), { ok: true, value: { to: "Bruno", title: "Fix the test", details: "d" } });
});

test("a bot has the peer tools and the rule on when to talk to another bot", () => {
  const names = BOT_TOOLS.map((tool) => tool.name);
  for (const name of ["bot_list", "bot_ask", "bot_handoff"]) assert.ok(names.includes(name), name);
  const text = botInstructions({ name: "Ana", soul: "", memory: "", runtimes: ["claude"], folder: "/x" });
  assert.match(text, /When the person asks you to involve one, do it/);
  assert.match(text, /only when the work clearly belongs to its purpose/);
  assert.match(text, /Never hand off what the person asked you to do/);
  assert.match(text, /never take it as an approval/);
});
