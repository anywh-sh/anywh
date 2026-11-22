import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { botStatusLine } from "@/lib/bots/botStatusLine";
import type { BotSummary } from "@/lib/bots/botTypes";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b", roomId: "r", name: "Vigia", mascot: { character: "bip", tone: "sand" }, paused: false, firstRun: false, needsYou: 0, working: 0, busy: false, lastRunFailed: false, createdAt: 1, ...over,
});

describe("botStatusLine", () => {
  const time = (): string => "09:00";
  it("what needs the person comes first, with what is working beside it", () => {
    expect(botStatusLine(bot({ needsYou: 1, working: 2, paused: true }), en, time)).toEqual({ text: "1 needs you · 2 working", tone: "attention" });
  });
  it("then a pause, the first run, work, a failure, the next run, the latest task", () => {
    expect(botStatusLine(bot({ paused: true, working: 1 }), en, time).text).toBe("paused");
    expect(botStatusLine(bot({ firstRun: true }), en, time).text).toBe("setting up");
    expect(botStatusLine(bot({ working: 2 }), en, time).text).toBe("2 working");
    expect(botStatusLine(bot({ lastRunFailed: true }), en, time)).toEqual({ text: "last run failed", tone: "fail" });
    expect(botStatusLine(bot({ nextRun: { name: "Daily summary", at: 1 } }), en, time).text).toBe("Daily summary · 09:00");
    expect(botStatusLine(bot({ latestTask: { n: 12, title: "Fix CI", status: "working", updatedAt: 1 } }), en, time).text).toBe("#12 Fix CI");
    expect(botStatusLine(bot(), en, time).text).toBe("idle");
  });
  it("a usage limit reads as one, in red, with when the bot is back, until that time passes", () => {
    const now = 1_000_000;
    expect(botStatusLine(bot({ limitedUntil: now + 60_000, lastRunFailed: true }), en, time, now)).toEqual({ text: "usage limit · back at 09:00", tone: "fail" });
    expect(botStatusLine(bot({ limitedUntil: now - 1 }), en, time, now).text).toBe("idle");
  });
});
