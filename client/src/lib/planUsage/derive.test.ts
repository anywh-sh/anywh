import { describe, expect, it } from "vitest";

import {
  EMPTY_PROFILE_USAGE,
  latestReadingAt,
  refreshCooldown,
  relayToLocal,
  neverSignedIn,
  statusBarRuntimes,
  READING_TIMEOUT_MS,
  isReading,
  profileReading,
  runtimeNote,
  accountWindows,
  spentUntil,
  countAccounts,
  groupByProfile,
  strongestWindow,
  profileDataState,
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

describe("runtimeWindows", () => {
  it("has no windows for states that show something else", () => {
    for (const status of ["signed_out", "no_subscription", "unknown"] as const) {
      expect(runtimeWindows(runtime({ runtime: "claude", status }), NOW)).toEqual([]);
    }
  });

  it("keeps the last good windows of an errored read", () => {
    expect(runtimeWindows(runtime({ runtime: "claude", status: "error" }), NOW)).toHaveLength(2);
  });
});

describe("strongestWindow", () => {
  it("is the larger of the windows", () => {
    expect(strongestWindow(runtimeWindows(runtime({ runtime: "claude" }), NOW))?.label).toBe("5h");
    const weekly = runtime({
      runtime: "claude",
      windows: [
        { durationMins: 300, usedPercent: 10, resetsAt: NOW + MIN },
        { durationMins: 10080, usedPercent: 70, resetsAt: NOW + 60 * MIN },
      ],
    });
    expect(strongestWindow(runtimeWindows(weekly, NOW))?.label).toBe("7d");
  });

  it("prefers the shorter window on a tie, and takes a lone 30-day window", () => {
    const tie = runtime({
      runtime: "claude",
      windows: [
        { durationMins: 300, usedPercent: 40, resetsAt: NOW + MIN },
        { durationMins: 10080, usedPercent: 40, resetsAt: NOW + 60 * MIN },
      ],
    });
    expect(strongestWindow(runtimeWindows(tie, NOW))?.label).toBe("5h");
    const free = runtime({ runtime: "codex", windows: [{ durationMins: 43200, usedPercent: 37, resetsAt: NOW + 60 * MIN, limitId: "codex" }] });
    expect(strongestWindow(runtimeWindows(free, NOW))).toMatchObject({ label: "30d", percent: 37 });
  });

  it("has none without windows", () => {
    expect(strongestWindow(runtimeWindows(runtime({ runtime: "codex", status: "signed_out", windows: [] }), NOW))).toBeNull();
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

describe("reading / runtimeNote", () => {
  const unknown: RuntimePlanUsage = { runtime: "claude", status: "unknown", windows: [], observedAt: null };

  it("believes the relay's reading flag only for a while after the state that carried it", () => {
    const usage = { ...unknown, reading: true };
    expect(isReading(usage, NOW, NOW)).toBe(true);
    expect(isReading(usage, NOW - READING_TIMEOUT_MS, NOW)).toBe(false);
    expect(isReading(usage, null, NOW)).toBe(false);
    expect(isReading(unknown, NOW, NOW)).toBe(false);
  });

  it("only reads on a live profile", () => {
    expect(profileReading(live([{ ...unknown, reading: true }]), NOW)).toBe(true);
    expect(profileReading({ ...live([{ ...unknown, reading: true }]), connection: "offline" }, NOW)).toBe(false);
    expect(profileReading(live([unknown]), NOW)).toBe(false);
    expect(profileReading(undefined, NOW)).toBe(false);
  });

  it("names why there is nothing, a read in progress first", () => {
    expect(runtimeNote(unknown, NOW, true)).toBe("reading");
    expect(runtimeNote(unknown, NOW, false)).toBe("notRead");
    expect(runtimeNote({ ...unknown, status: "signed_out" }, NOW, false)).toBe("signedOut");
    expect(runtimeNote({ ...unknown, status: "no_subscription" }, NOW, false)).toBe("apiKey");
    expect(runtimeNote({ ...unknown, status: "error", error: { kind: "network" } }, NOW, false)).toBe("errorNetwork");
    expect(runtimeNote({ ...unknown, status: "error", error: { kind: "auth" } }, NOW, false)).toBe("errorAuth");
    expect(runtimeNote({ ...unknown, status: "error", error: { kind: "parse" } }, NOW, false)).toBe("errorParse");
    expect(runtimeNote({ ...unknown, status: "error" }, NOW, false)).toBe("error");
    expect(runtimeNote(runtime({ runtime: "claude" }), NOW, true)).toBeNull();
  });
});

describe("neverSignedIn / statusBarRuntimes", () => {
  const out = (everSignedIn?: boolean): RuntimePlanUsage => ({ runtime: "codex", status: "signed_out", windows: [], observedAt: null, ...(everSignedIn === undefined ? {} : { everSignedIn }) });

  it("tells a login never made on this profile from one that was lost", () => {
    expect(neverSignedIn(out(false))).toBe(true);
    expect(neverSignedIn(out(true))).toBe(false);
    // A relay that predates the field: every signed_out is a lost login.
    expect(neverSignedIn(out())).toBe(false);
    expect(neverSignedIn({ ...runtime({ runtime: "claude" }), everSignedIn: false })).toBe(false);
  });

  it("keeps a never-used agent out of the status bar only", () => {
    const claude = runtime({ runtime: "claude" });
    expect(statusBarRuntimes([claude, out(false)])).toEqual([claude]);
    expect(statusBarRuntimes([claude, out(true)])).toHaveLength(2);
    expect(statusBarRuntimes([claude, out()])).toHaveLength(2);
    // The card's groups and the account count don't change.
    const groups = groupByProfile(["a"], { a: live([claude, out(false)]) }, "a");
    expect(groups[0].accounts.map((entry) => entry.runtime)).toEqual(["claude", "codex"]);
    expect(countAccounts(groups)).toBe(1);
  });
});

describe("relay clock / refreshCooldown / latestReadingAt", () => {
  // Relay 10s ahead: it built the state at NOW + 10s, it arrived at NOW.
  const skewed = (runtimes: RuntimePlanUsage[]): ProfilePlanUsage => ({ ...live(runtimes), observedAt: NOW + 10_000, receivedAt: NOW });

  it("moves a relay timestamp into this client's clock", () => {
    expect(relayToLocal(NOW + 70_000, skewed([]))).toBe(NOW + 60_000);
    expect(relayToLocal(NOW, { ...live([]), observedAt: null })).toBe(NOW);
  });

  it("waits for the first runtime to leave its floor, and not at all without one", () => {
    const claude = runtime({ runtime: "claude", refreshableAt: NOW + 70_000 });
    const codex = runtime({ runtime: "codex", refreshableAt: NOW + 25_000 });
    const groups = groupByProfile(["a"], { a: skewed([claude, codex]) }, "a");
    expect(refreshCooldown(groups, NOW)).toBe(15_000);
    expect(refreshCooldown(groups, NOW + 15_000)).toBeNull();
    expect(refreshCooldown(groupByProfile(["a"], { a: skewed([claude, runtime({ runtime: "codex" })]) }, "a"), NOW)).toBeNull();
    expect(refreshCooldown(groupByProfile(["a"], { a: skewed([]) }, "a"), NOW)).toBeNull();
    // An unreachable profile holds nothing.
    expect(refreshCooldown(groupByProfile(["a"], { a: { ...skewed([claude]), connection: "offline" } }, "a"), NOW)).toBeNull();
  });

  it("dates the newest reading, not the newest message", () => {
    const groups = groupByProfile(["a"], { a: skewed([runtime({ runtime: "claude", observedAt: NOW - 50_000 }), runtime({ runtime: "codex", observedAt: NOW - 20_000 })]) }, "a");
    expect(latestReadingAt(groups)).toBe(NOW - 30_000);
    expect(latestReadingAt([])).toBeNull();
  });
});
