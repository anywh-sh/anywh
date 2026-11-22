import type { BotSummary, BotView, MemoryLine } from "@/lib/bots/botTypes";
import type { Profile } from "@/lib/profiles/profiles";

// Sample bots for the stories: one per state the sidebar and the panel draw.

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-21T11:20:00Z");

export const storyProfile: Profile = { id: "story", label: "Story", host: "127.0.0.1", relayPort: 1 };

const base: BotSummary = {
  id: "vigia",
  roomId: "room-vigia",
  name: "Vigia",
  mascot: { character: "bip", tone: "sand" },
  paused: false,
  firstRun: false,
  needsYou: 0,
  working: 0,
  busy: false,
  lastRunFailed: false,
  createdAt: NOW - 72 * HOUR,
};

export const storyBots: BotSummary[] = [
  { ...base, needsYou: 1, working: 2 },
  { ...base, id: "revisor", roomId: "room-revisor", name: "Revisor", mascot: { character: "specs", tone: "chalk" }, busy: true, working: 1 },
  { ...base, id: "standup", roomId: "room-standup", name: "Standup", mascot: { character: "headset", tone: "sage" }, nextRun: { name: "Daily summary", at: NOW + 22 * HOUR } },
  { ...base, id: "faxina", roomId: "room-faxina", name: "Faxina", mascot: { character: "helmet", tone: "stone" }, paused: true },
  { ...base, id: "docs", roomId: "room-docs", name: "Docs", mascot: { character: "screen", tone: "slate" }, lastRunFailed: true },
  { ...base, id: "triagem", roomId: "room-triagem", name: "Triagem", mascot: { character: "visor", tone: "rose" }, firstRun: true },
  // Waiting out its agent's usage limit (relative to the real clock, so the
  // story keeps showing it).
  { ...base, id: "chip", roomId: "room-chip", name: "Chip", mascot: { character: "chip", tone: "sage" }, limitedUntil: Date.now() + 58 * 60_000 },
];

export const storyBotView: BotView = {
  ...storyBots[0],
  conversationNeedsYou: false,
  tasks: [
    {
      n: 13,
      title: "Retry strategy for the relay e2e",
      status: "needs_you",
      question: { question: "Retry per test or the whole job?", options: ["Per test, at most 2 tries", "The whole job", "No retry: fix the cause"], recommended: 0, askedAt: NOW - HOUR },
      notes: [],
      workers: [],
      createdAt: NOW - 2 * HOUR,
      updatedAt: NOW - HOUR,
    },
    {
      n: 12,
      title: "Fix the flaky relay test",
      status: "working",
      doneMeans: "e2e-relay passes 20 times in a row on main, with no manual retry.",
      notes: [
        { text: "Started from the 11:00 CI check", at: NOW - 3 * HOUR },
        { text: "The test reconnects before the relay saves the session", at: NOW - 2 * HOUR },
      ],
      workers: [{ agentId: "w12", title: "Fix flaky test", state: "working", startedAt: NOW - 4 * 60_000 }],
      createdAt: NOW - 3 * HOUR,
      updatedAt: NOW - 30 * 60_000,
    },
    { n: 14, title: "Clean up old workflows", status: "planned", notes: [], workers: [], createdAt: NOW - 5 * HOUR, updatedAt: NOW - 5 * HOUR },
    { n: 9, title: "Move the CI cache", status: "done", notes: [{ text: "Merged in PR 480", at: NOW - 24 * HOUR }], workers: [], createdAt: NOW - 48 * HOUR, updatedAt: NOW - 24 * HOUR },
    { n: 8, title: "Pin the node version", status: "canceled", notes: [], workers: [], createdAt: NOW - 50 * HOUR, updatedAt: NOW - 30 * HOUR },
  ],
  schedules: [
    { id: "s1", name: "CI check", cron: "0 9-18 * * 1-5", prompt: "", paused: false, nextRunAt: NOW + 40 * 60_000, running: false, runs: [{ at: NOW - 20 * 60_000, outcome: "silent" }] },
    { id: "s2", name: "Weekly summary", cron: "0 17 * * 5", prompt: "", paused: true, running: false, runs: [] },
  ],
};

export const storyEmptyBot: BotView = { ...storyBots[5], conversationNeedsYou: false, tasks: [], schedules: [] };

export const storySoul = "I watch the CI of the main branch and tell a flaky test from a real failure.\n\n## How I work\n- I check recent runs with gh.\n\n## Never\n- Merge anything.";

export const storyMemory: MemoryLine[] = [
  { index: 0, kind: "rule", text: "Never merge: pull requests stay drafts.", source: "conversation", date: "2026-11-18", raw: "- [rule] Never merge" },
  { index: 1, kind: "preference", text: "Retry a test at most twice.", source: "task #13", date: "2026-11-20", raw: "- [preference] Retry" },
  { index: 2, kind: "fact", text: "e2e-relay runs against the local relay, not staging.", source: "task #12", date: "2026-11-21", raw: "- [fact] e2e-relay" },
];
