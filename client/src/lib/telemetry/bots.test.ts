import { describe, expect, it } from "vitest";
import { BotRequestError } from "@/lib/bots/botClient";
import type { BotSummary } from "@/lib/bots/botTypes";
import { BOT_TEMPLATES } from "@/lib/bots/templates";
import { botsSnapshot, createFailureOf, templateKind } from "@/lib/telemetry/bots";
import { BOT_TEMPLATE_KINDS, validateEvent } from "@/lib/telemetry/events";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b", roomId: "r", name: "Vigia", mascot: { character: "bip", tone: "sand" }, paused: false, firstRun: false, needsYou: 0, working: 0, busy: false, lastRunFailed: false, createdAt: 1, ...over,
});
const recent = { scheduleCount: 1, runs24h: { replied: 2, silent: 1, failed: 1, missed: 1, limited: 0 }, peer24h: { asks: 1, handoffs: 2 } };

describe("what the bots' state reduces to", () => {
  it("knows every template this build ships, and nothing it does not", () => {
    for (const template of BOT_TEMPLATES) expect(BOT_TEMPLATE_KINDS).toContain(template.id);
    expect(templateKind(undefined)).toBe("blank");
    expect(templateKind("ci-check")).toBe("ci-check");
    expect(templateKind("my-own")).toBe("other");
    expect(templateKind("blank")).toBe("other");
  });

  it("tells why creating failed from the relay's answer, never its words", () => {
    expect(createFailureOf(new BotRequestError("agent host is not connected", 503))).toBe("no_host");
    expect(createFailureOf(new BotRequestError("invalid soul", 400))).toBe("invalid");
    expect(createFailureOf(new TypeError("Failed to fetch"))).toBe("network");
    expect(createFailureOf(new Error("??"))).toBe("other");
  });

  it("counts a profile's bots, and adds the relay's day counts only when every bot has them", () => {
    const old = botsSnapshot([bot({ templateId: "ci-check", paused: true }), bot({ firstRun: true, nextRun: { name: "x", at: 1 }, needsYou: 2, lastRunFailed: true })]);
    expect(old).toEqual({ bot_count: 2, from_template: 1, paused: 1, first_run: 1, scheduled: 1, last_run_failed: 1, limited: 0, needs_you: 2 });
    const current = botsSnapshot([bot(recent), bot(recent)]);
    expect(current).toMatchObject({ schedules: 2, runs_24h_replied: 4, runs_24h_failed: 2, runs_24h_missed: 2, peer_asks_24h: 2, peer_handoffs_24h: 4 });
    expect(botsSnapshot([bot(recent), bot()]).schedules).toBeUndefined();
    for (const snapshot of [old, current, botsSnapshot([])]) expect(validateEvent("bots_snapshot", snapshot)).not.toBeNull();
  });

  it("caps a count instead of losing the whole snapshot", () => {
    const many = Array.from({ length: 150 }, () => bot({ needsYou: 10 }));
    expect(validateEvent("bots_snapshot", botsSnapshot(many))).toMatchObject({ bot_count: 100, needs_you: 1000 });
  });
});
