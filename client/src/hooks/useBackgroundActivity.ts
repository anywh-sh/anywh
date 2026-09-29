import { useMemo } from "react";
import type { Tab } from "@/hooks/tabs/useTabs";
import type { TurnProgress } from "@/components/chat/ChatPanel";
import type { BackgroundJobSummary, FailedBackgroundJobSummary } from "@/lib/relay/relayClient";
import { profileColorVar } from "@/lib/profiles/profiles";
import type { Dictionary } from "@/i18n";

/** One open tab's own `anywh-bg` jobs and in-flight turn, lifted up from its
 * `ChatPanel` — see `TabPanelActions.onBackgroundJobsChange`/
 * `onTurnProgressChange`. */
export interface BackgroundActivityEntry {
  jobs: BackgroundJobSummary[];
  failedJobs: FailedBackgroundJobSummary[];
  turn: TurnProgress | null;
}

export type BackgroundActivityStatus = "run" | "fail";

export interface BackgroundActivityItem {
  /** Stable across renders — the job's own id for a `proc` row, `tab:<id>`
   * for an `agent` row (a tab has no "job id" of its own). */
  id: string;
  kind: "agent" | "proc";
  tabId: string;
  profileId: string;
  name: string;
  tail: string;
  status: BackgroundActivityStatus;
  /** epoch ms — start time while running, finish time once failed. `null`
   * for an agent row whose turn start hasn't been reported yet: showing no
   * duration beats counting one from the epoch. */
  time: number | null;
}

interface UseBackgroundActivityArgs {
  tabs: Tab[];
  activeTabId: string | null;
  byTab: Record<string, BackgroundActivityEntry>;
  dict: Dictionary;
}

/**
 * Cross-session "what's running in the background right now" list for the
 * status bar tray — both kinds are read from state the app already tracks
 * elsewhere, nothing new modeled just for this view:
 *
 * - `agent` rows: another open tab with a turn in flight right now. The
 *   focused tab is excluded on purpose — its own activity is already on
 *   screen via `TurnIndicator`, repeating it here would be noise.
 * - `proc` rows: `anywh-bg` jobs (running, or failed and kept until
 *   dismissed), across every open tab, not just the focused one.
 *
 * Sorted running-first, failed-last, matching the design.
 */
export function useBackgroundActivity({ tabs, activeTabId, byTab, dict }: UseBackgroundActivityArgs): BackgroundActivityItem[] {
  return useMemo(() => {
    const items: BackgroundActivityItem[] = [];
    for (const tab of tabs) {
      const entry = byTab[tab.id];

      if (tab.isRunning && tab.id !== activeTabId) {
        items.push({
          id: `tab:${tab.id}`,
          kind: "agent",
          tabId: tab.id,
          profileId: tab.profileId,
          name: tab.title ?? dict.common.untitledSession,
          tail: entry?.turn?.latestToolCall ?? "",
          status: "run",
          time: entry?.turn?.startedAt ?? null,
        });
      }

      if (!entry) continue;

      // An older relay's `background_job_state` (pre-dating `failedJobs`)
      // sends `{ jobs }` with no `failedJobs` field at all — `?? []` here is
      // what keeps a version-skewed relay from crashing this view instead of
      // just showing an empty failed list.
      for (const job of entry.jobs ?? []) {
        items.push({
          id: job.id,
          kind: "proc",
          tabId: tab.id,
          profileId: tab.profileId,
          name: job.label,
          tail: "",
          status: "run",
          time: job.startedAt,
        });
      }
      for (const job of entry.failedJobs ?? []) {
        const tailLines = job.logTail.trim().split("\n");
        items.push({
          id: job.id,
          kind: "proc",
          tabId: tab.id,
          profileId: tab.profileId,
          name: job.label,
          tail: tailLines[tailLines.length - 1] ?? "",
          status: "fail",
          time: job.finishedAt,
        });
      }
    }

    return items.sort((a, b) => (a.status === b.status ? 0 : a.status === "fail" ? 1 : -1));
  }, [tabs, activeTabId, byTab, dict]);
}

export function backgroundActivityProfileColor(item: BackgroundActivityItem): string {
  return profileColorVar(item.profileId);
}
