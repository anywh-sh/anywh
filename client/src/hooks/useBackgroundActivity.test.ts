import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBackgroundActivity, type BackgroundActivityEntry } from "@/hooks/useBackgroundActivity";
import type { Tab } from "@/hooks/tabs/useTabs";
import { getDictionary } from "@/i18n";

const dict = getDictionary("en");

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    profileId: "p1",
    title: "My session",
    hasUnreadCompletion: false,
    isRunning: false,
    hasBackgroundJob: false,
    isNew: false,
    ...overrides,
  };
}

describe("useBackgroundActivity", () => {
  it("surfaces another running tab as an 'agent' item, but not the focused one", () => {
    const tabs = [makeTab({ id: "focused", isRunning: true }), makeTab({ id: "other", isRunning: true })];
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: "focused", byTab: {}, dict }));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ id: "tab:other", kind: "agent", tabId: "other", status: "run" });
  });

  it("times an agent item from its turn's real start, and says what it last called", () => {
    const tabs = [makeTab({ id: "other", isRunning: true })];
    const byTab: Record<string, BackgroundActivityEntry> = {
      other: { jobs: [], failedJobs: [], turn: { startedAt: 5000, latestToolCall: "Bash npm test" } },
    };
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab, dict }));

    expect(result.current[0]).toMatchObject({ kind: "agent", time: 5000, tail: "Bash npm test" });
  });

  it("leaves an agent item untimed until its turn start is known, instead of counting from the epoch", () => {
    const tabs = [makeTab({ id: "other", isRunning: true })];
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab: {}, dict }));

    expect(result.current[0].time).toBeNull();
  });

  it("does not report a running tab as an agent item once it becomes the focused one", () => {
    const tabs = [makeTab({ id: "tab-1", isRunning: true })];
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: "tab-1", byTab: {}, dict }));

    expect(result.current).toHaveLength(0);
  });

  it("lists every open tab's own anywh-bg jobs, running and failed", () => {
    const tabs = [makeTab({ id: "tab-1" }), makeTab({ id: "tab-2", profileId: "p2" })];
    const byTab: Record<string, BackgroundActivityEntry> = {
      "tab-1": { jobs: [{ id: "j1", label: "pnpm dev", startedAt: 1000, pid: 42 }], failedJobs: [], turn: null },
      "tab-2": {
        jobs: [],
        failedJobs: [{ id: "j2", label: "migrate", pid: 43, exitCode: 1, logTail: "boom", finishedAt: 2000 }],
        turn: null,
      },
    };
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab, dict }));

    const proc = result.current.find((item) => item.id === "j1");
    expect(proc).toMatchObject({ kind: "proc", tabId: "tab-1", name: "pnpm dev", status: "run", time: 1000 });

    const failed = result.current.find((item) => item.id === "j2");
    expect(failed).toMatchObject({ kind: "proc", tabId: "tab-2", name: "migrate", status: "fail", time: 2000, tail: "boom" });
  });

  it("sorts running/queued items before failed ones", () => {
    const tabs = [makeTab({ id: "tab-1" })];
    const byTab: Record<string, BackgroundActivityEntry> = {
      "tab-1": {
        jobs: [{ id: "run", label: "running", startedAt: 1, pid: 1 }],
        failedJobs: [{ id: "fail", label: "failed", pid: 2, exitCode: 1, logTail: "", finishedAt: 1 }],
        turn: null,
      },
    };
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab, dict }));

    expect(result.current.map((item) => item.status)).toEqual(["run", "fail"]);
  });

  it("does not crash on an entry with no failedJobs array (an older relay's message)", () => {
    // Belt and suspenders alongside relayClient.test.ts's own coverage of
    // this: whatever fills `byTab` should never be able to reach this hook
    // with a missing `failedJobs`, but this is cheap insurance against a
    // future caller that skips that guarantee.
    const tabs = [makeTab({ id: "tab-1" })];
    const byTab = {
      "tab-1": { jobs: [{ id: "j1", label: "pnpm dev", startedAt: 1, pid: 1 }] },
    } as unknown as Record<string, BackgroundActivityEntry>;

    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab, dict }));

    expect(result.current).toEqual([expect.objectContaining({ id: "j1", status: "run" })]);
  });

  it("falls back to the untitled-session label for an agent item with no title yet", () => {
    const tabs = [makeTab({ id: "tab-1", title: null, isRunning: true })];
    const { result } = renderHook(() => useBackgroundActivity({ tabs, activeTabId: null, byTab: {}, dict }));

    expect(result.current[0].name).toBe(dict.common.untitledSession);
  });
});
