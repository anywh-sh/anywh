import { describe, expect, it } from "vitest";

import {
  EMPTY_PROFILE_USAGE,
  accountWindows,
  spentUntil,
  countAccounts,
  groupByProfile,
  headlineWindow,
  otherProfileAlerts,
  profileDataState,
  runtimeLevel,
  runtimeWindows,
  windowView,
  type ProfilePlanUsage,
} from "@/lib/planUsage/derive";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MIN = 60_000;

function runtime(overrides: Partial<RuntimePlanUsage> & Pick<RuntimePlanUsage, "runtime">): RuntimePlanUsage {
  return {
    status: "ok",
    windows: [
      { durationMins: 300, usedPercent: 58, resetsAt: NOW + 120 * MIN },
      { durationMins: 10080, usedPercent: 41, resetsAt: NOW + 3 * 24 * 60 * MIN },
    ],
    observedAt: NOW - 12_000,
    ...overrides,
  };
}

function live(runtimes: RuntimePlanUsage[]): ProfilePlanUsage {
  return { connection: "live", runtimes, observedAt: NOW, receivedAt: NOW, refreshing: false };
}

describe("windowView", () => {
  it("labels the window and places the pace mark", () => {
    const view = windowView({ durationMins: 300, usedPercent: 58, resetsAt: NOW + 120 * MIN }, NOW);
    expect(view).toMatchObject({ label: "5h", percent: 58, expected: 60, level: "neutral", expired: false });
  });

  it("brings an expired window to 0% with no pace and no warning", () => {
    const view = windowView({ durationMins: 300, usedPercent: 100, resetsAt: NOW - MIN }, NOW, { warning: true });
    expect(view).toMatchObject({ percent: 0, expected: null, level: "neutral", expired: true });
  });

  it("drops the pace on a spent window and without a reset time", () => {
    expect(windowView({ durationMins: 300, usedPercent: 100, resetsAt: NOW + MIN }, NOW)).toMatchObject({
      level: "limited",
      expected: null,
    });
    expect(windowView({ durationMins: 300, usedPercent: 30, resetsAt: null }, NOW).expected).toBeNull();
  });

  it("lets the agent's warning raise a live window", () => {
    expect(windowView({ durationMins: 300, usedPercent: 30, resetsAt: NOW + MIN }, NOW, { warning: true }).level).toBe("warn");
  });
});

describe("runtimeWindows / runtimeLevel", () => {
  it("has no windows for states that show something else", () => {
    for (const status of ["signed_out", "no_subscription", "unknown"] as const) {
      expect(runtimeWindows(runtime({ runtime: "claude", status }), NOW)).toEqual([]);
      expect(runtimeLevel(runtime({ runtime: "claude", status }), NOW)).toBe("neutral");
    }
  });

  it("keeps the last good windows of an errored read", () => {
    expect(runtimeWindows(runtime({ runtime: "claude", status: "error" }), NOW)).toHaveLength(2);
  });

  it("is the worst window, raised by the warning status", () => {
    expect(runtimeLevel(runtime({ runtime: "claude" }), NOW)).toBe("neutral");
    expect(runtimeLevel(runtime({ runtime: "claude", status: "warning" }), NOW)).toBe("warn");
    const hot = runtime({
      runtime: "claude",
      windows: [
        { durationMins: 300, usedPercent: 20, resetsAt: NOW + MIN },
        { durationMins: 10080, usedPercent: 85, resetsAt: NOW + 60 * MIN },
      ],
    });
    expect(runtimeLevel(hot, NOW)).toBe("warn");
  });

  it("reads limited from the relay until the window it was about resets", () => {
    const rejected = runtime({ runtime: "claude", status: "limited", windows: [{ durationMins: 300, usedPercent: 90, resetsAt: NOW + MIN }] });
    expect(runtimeLevel(rejected, NOW)).toBe("limited");
    expect(runtimeLevel(rejected, NOW + 2 * MIN)).toBe("neutral");
  });
});

describe("headlineWindow", () => {
  it("is the larger of the windows", () => {
    expect(headlineWindow(runtime({ runtime: "claude" }), NOW)?.label).toBe("5h");
    const weekly = runtime({
      runtime: "claude",
      windows: [
        { durationMins: 300, usedPercent: 10, resetsAt: NOW + MIN },
        { durationMins: 10080, usedPercent: 70, resetsAt: NOW + 60 * MIN },
      ],
    });
    expect(headlineWindow(weekly, NOW)?.label).toBe("7d");
  });

  it("prefers the shorter window on a tie, and takes a lone 30-day window", () => {
    const tie = runtime({
      runtime: "claude",
      windows: [
        { durationMins: 300, usedPercent: 40, resetsAt: NOW + MIN },
        { durationMins: 10080, usedPercent: 40, resetsAt: NOW + 60 * MIN },
      ],
    });
    expect(headlineWindow(tie, NOW)?.label).toBe("5h");
    const free = runtime({ runtime: "codex", windows: [{ durationMins: 43200, usedPercent: 37, resetsAt: NOW + 60 * MIN, limitId: "codex" }] });
    expect(headlineWindow(free, NOW)).toMatchObject({ label: "30d", percent: 37 });
  });

  it("has none without windows", () => {
    expect(headlineWindow(runtime({ runtime: "codex", status: "signed_out", windows: [] }), NOW)).toBeNull();
  });
});

describe("profileDataState", () => {
  it("tells live, stale, none and unsupported apart", () => {
    expect(profileDataState(undefined)).toBe("none");
    expect(profileDataState(EMPTY_PROFILE_USAGE)).toBe("none");
    expect(profileDataState(live([]))).toBe("live");
    expect(profileDataState({ ...live([runtime({ runtime: "claude" })]), connection: "offline" })).toBe("stale");
    expect(profileDataState({ ...EMPTY_PROFILE_USAGE, connection: "offline" })).toBe("none");
    expect(profileDataState({ ...EMPTY_PROFILE_USAGE, connection: "unsupported" })).toBe("unsupported");
  });
});

describe("groupByProfile", () => {
  it("puts the active profile first, then the list's order, Claude before Codex", () => {
    const groups = groupByProfile(
      ["pessoal", "trabalho", "lab"],
      {
        pessoal: live([runtime({ runtime: "codex" }), runtime({ runtime: "claude" })]),
        trabalho: live([runtime({ runtime: "claude" })]),
      },
      "trabalho",
    );
    expect(groups.map((group) => [group.profileId, group.active, group.data])).toEqual([
      ["trabalho", true, "live"],
      ["pessoal", false, "live"],
      ["lab", false, "none"],
    ]);
    expect(groups[1].accounts.map((entry) => entry.runtime)).toEqual(["claude", "codex"]);
    expect(groups[2].accounts).toEqual([]);
  });

  it("keeps the list's order when the active profile isn't in it", () => {
    expect(groupByProfile(["a", "b"], {}, "gone").map((group) => group.profileId)).toEqual(["a", "b"]);
    expect(groupByProfile(["a", "b"], {}, null).map((group) => group.active)).toEqual([false, false]);
  });

  it("shows a shared account in full once, at its first appearance, and as a reference after", () => {
    const groups = groupByProfile(
      ["pessoal", "trabalho"],
      {
        pessoal: live([runtime({ runtime: "claude", accountKey: "aaaa" }), runtime({ runtime: "codex", accountKey: "aaaa" })]),
        trabalho: live([runtime({ runtime: "claude", accountKey: "aaaa" }), runtime({ runtime: "codex", accountKey: "bbbb" })]),
      },
      "trabalho",
    );
    // The active profile comes first, so it owns the shared account.
    expect(groups[0].accounts.map((entry) => entry.sameAccountAs)).toEqual([undefined, undefined]);
    // Same key on a different runtime is a different account.
    expect(groups[1].accounts.map((entry) => entry.sameAccountAs)).toEqual(["trabalho", undefined]);
    expect(countAccounts(groups)).toBe(3);
  });

  it("never matches accounts without a key", () => {
    const groups = groupByProfile(
      ["a", "b"],
      { a: live([runtime({ runtime: "claude" })]), b: live([runtime({ runtime: "claude" })]) },
      "a",
    );
    expect(groups[1].accounts[0].sameAccountAs).toBeUndefined();
  });

  it("keeps a sleeping profile's last numbers, marked stale", () => {
    const groups = groupByProfile(["a"], { a: { ...live([runtime({ runtime: "claude" })]), connection: "offline" } }, null);
    expect(groups[0]).toMatchObject({ data: "stale" });
    expect(groups[0].accounts).toHaveLength(1);
  });

  it("doesn't count a runtime with no login as an account", () => {
    const groups = groupByProfile(
      ["a"],
      { a: live([runtime({ runtime: "claude" }), runtime({ runtime: "codex", status: "signed_out", windows: [] })]) },
      "a",
    );
    expect(countAccounts(groups)).toBe(1);
  });
});

describe("otherProfileAlerts", () => {
  const at = (percent: number): RuntimePlanUsage[] => [
    runtime({ runtime: "claude", windows: [{ durationMins: 300, usedPercent: percent, resetsAt: NOW + 30 * MIN }] }),
  ];

  it("flags inactive profiles at 80% or more, and spent ones as limited", () => {
    const groups = groupByProfile(
      ["active", "warm", "hot", "spent", "cool"],
      { active: live(at(100)), warm: live(at(79)), hot: live(at(80)), spent: live(at(100)), cool: live(at(10)) },
      "active",
    );
    expect(otherProfileAlerts(groups, NOW)).toEqual([
      { profileId: "hot", level: "warn" },
      { profileId: "spent", level: "limited" },
    ]);
  });

  it("takes the worst account of the profile", () => {
    const groups = groupByProfile(
      ["active", "other"],
      {
        active: live([]),
        other: live([
          runtime({ runtime: "claude", windows: [{ durationMins: 300, usedPercent: 85, resetsAt: NOW + MIN }] }),
          runtime({ runtime: "codex", windows: [{ durationMins: 300, usedPercent: 100, resetsAt: NOW + MIN }] }),
        ]),
      },
      "active",
    );
    expect(otherProfileAlerts(groups, NOW)).toEqual([{ profileId: "other", level: "limited" }]);
  });

  it("skips a repeat of an account shown elsewhere, and lets a reset clear the alert", () => {
    const shared = [runtime({ runtime: "claude", accountKey: "k", windows: [{ durationMins: 300, usedPercent: 100, resetsAt: NOW + MIN }] })];
    const groups = groupByProfile(["active", "other"], { active: live(shared), other: live(shared) }, "active");
    expect(otherProfileAlerts(groups, NOW)).toEqual([]);

    const alone = groupByProfile(["active", "other"], { active: live([]), other: { ...live(shared), connection: "offline" } }, "active");
    expect(otherProfileAlerts(alone, NOW)).toEqual([{ profileId: "other", level: "limited" }]);
    expect(otherProfileAlerts(alone, NOW + 2 * MIN)).toEqual([]);
  });
});

describe("accountWindows / spentUntil", () => {
  const view = (durationMins: number, usedPercent: number, resetsAt: number | null, limitId?: string) =>
    windowView({ durationMins, usedPercent, resetsAt, limitId }, NOW);

  it("keeps the account's own windows, falling back to all", () => {
    const opus = view(10080, 90, NOW + MIN, "seven_day_opus");
    expect(accountWindows([view(300, 10, NOW + MIN), opus]).map((v) => v.limitId)).toEqual([undefined]);
    expect(accountWindows([view(43200, 37, NOW + MIN, "codex")])).toHaveLength(1);
    expect(accountWindows([opus])).toEqual([opus]);
  });

  it("is the latest reset among the spent windows", () => {
    expect(spentUntil([view(300, 100, NOW + 10 * MIN), view(10080, 100, NOW + 90 * MIN)])).toBe(NOW + 90 * MIN);
    expect(spentUntil([view(300, 100, NOW + 10 * MIN), view(10080, 50, NOW + 90 * MIN)])).toBe(NOW + 10 * MIN);
    expect(spentUntil([view(300, 99, NOW + 10 * MIN)])).toBeNull();
    expect(spentUntil([view(300, 100, null)])).toBeNull();
  });
});
