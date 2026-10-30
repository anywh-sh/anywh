import { effectivePercent, expectedPace, isWindowExpired, showsPaceMark, usageLevel, windowLabel, type UsageLevel } from "@/lib/planUsage/meter";
import type { PlanUsageRuntime, PlanWindow, RuntimePlanUsage } from "@/lib/planUsage/model";

/**
 * What the usage view shows, derived from what each profile's relay last
 * said and the client's own clock. Pure: the hook (`usePlanUsage`) owns the
 * sockets and the clock, the components own the layout, and everything in
 * between — which window leads, which account is a repeat of another, which
 * inactive profile deserves an alert — lives here, where it can be tested
 * without either.
 */

/**
 * Where a profile's plan usage socket stands.
 * - `connecting`: no answer yet since the watch started.
 * - `live`: connected, and the relay has sent its state.
 * - `offline`: the relay can't be reached right now (machine asleep, network
 *   down, relay restarting) — retried in the background. The last state it
 *   sent, if any, is kept.
 * - `unsupported`: the relay predates plan usage. Final: not retried.
 * - `revoked`: this device's access to the profile was revoked. Final.
 */
export type PlanUsageConnection = "connecting" | "live" | "offline" | "unsupported" | "revoked";

export interface ProfilePlanUsage {
  connection: PlanUsageConnection;
  /** The relay's last `plan_usage_state`, kept across disconnects; `null`
   * until one arrives. */
  runtimes: RuntimePlanUsage[] | null;
  /** The `observedAt` of that message (relay clock), epoch ms. */
  observedAt: number | null;
  /** When this client received it (client clock), epoch ms. */
  receivedAt: number | null;
  /** A refresh was asked and its answer hasn't arrived. */
  refreshing: boolean;
}

export const EMPTY_PROFILE_USAGE: ProfilePlanUsage = {
  connection: "connecting",
  runtimes: null,
  observedAt: null,
  receivedAt: null,
  refreshing: false,
};

/**
 * What a profile's numbers are worth right now:
 * - `live`: current.
 * - `stale`: the relay is unreachable and these are the last numbers it sent.
 *   Still shown — an asleep machine's agents aren't spending anything — but
 *   a view should say they are old.
 * - `none`: nothing to show (never answered, or nothing cached).
 * - `unsupported`: the relay is too old to report plan usage.
 */
export type PlanUsageDataState = "live" | "stale" | "none" | "unsupported";

export function profileDataState(entry: ProfilePlanUsage | undefined): PlanUsageDataState {
  if (!entry) return "none";
  if (entry.connection === "unsupported") return "unsupported";
  if (!entry.runtimes) return "none";
  return entry.connection === "live" ? "live" : "stale";
}

/** One window, ready to draw. */
export interface WindowView {
  durationMins: number;
  limitId?: string;
  label: string;
  /** Whole percent; 0 once the window's reset time has passed. */
  percent: number;
  /** Even-pace position, whole percent; `null` when there is no mark to
   * draw (spent, expired, or no reset time). */
  expected: number | null;
  level: UsageLevel;
  resetsAt: number | null;
  expired: boolean;
}

/** Statuses for which a runtime's windows mean something. The others show a
 * state of their own (no login, API key, nothing read yet). */
const HAS_WINDOWS = new Set<RuntimePlanUsage["status"]>(["ok", "warning", "limited", "error"]);

export function windowView(window: PlanWindow, nowMs: number, options: { warning?: boolean } = {}): WindowView {
  const resetsAt = window.resetsAt;
  const expired = resetsAt !== null && isWindowExpired(resetsAt, nowMs);
  const percent = effectivePercent(window.usedPercent, resetsAt ?? Number.NaN, nowMs);
  const pace = resetsAt === null || expired || !showsPaceMark(percent) ? null : expectedPace(window.durationMins, resetsAt, nowMs);
  return {
    durationMins: window.durationMins,
    limitId: window.limitId,
    label: windowLabel(window.durationMins),
    percent,
    expected: pace,
    // An expired window carries no warning: the flag was about the window
    // that just ended.
    level: usageLevel(percent, { warning: options.warning && !expired }),
    resetsAt,
    expired,
  };
}

/** A runtime's windows, ascending by duration as the relay sends them. Empty
 * for a runtime whose status has no windows to show. */
export function runtimeWindows(usage: RuntimePlanUsage, nowMs: number): WindowView[] {
  if (!HAS_WINDOWS.has(usage.status)) return [];
  return usage.windows.map((window) => windowView(window, nowMs, { warning: usage.status === "warning" }));
}

const LEVEL_RANK: Record<UsageLevel, number> = { neutral: 0, warn: 1, limited: 2 };

export function worseLevel(a: UsageLevel, b: UsageLevel): UsageLevel {
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/** The runtime's state as one color: its worst window, raised to warn by the
 * agent's own warning flag. `limited` from the relay without a spent window
 * to show (a rejection that named none) still reads as limited — until the
 * window it was about has reset, which the windows themselves say. */
export function runtimeLevel(usage: RuntimePlanUsage, nowMs: number): UsageLevel {
  const windows = runtimeWindows(usage, nowMs);
  let level = windows.reduce<UsageLevel>((worst, view) => worseLevel(worst, view.level), "neutral");
  if (usage.status === "limited" && windows.every((view) => !view.expired)) level = "limited";
  return level;
}

/**
 * The window the status bar's small bar stands for: the most used one —
 * "the larger of 5h and 7d" on a paid plan, the only one on Codex's free
 * 30-day plan. A tie goes to the shorter window, the one that resets first.
 */
export function headlineWindow(usage: RuntimePlanUsage, nowMs: number): WindowView | null {
  return strongestWindow(runtimeWindows(usage, nowMs));
}

/** The most used of `views`; a tie goes to the shorter window. */
export function strongestWindow(views: readonly WindowView[]): WindowView | null {
  let best: WindowView | null = null;
  for (const view of views) {
    if (!best || view.percent > best.percent || (view.percent === best.percent && view.durationMins < best.durationMins)) {
      best = view;
    }
  }
  return best;
}

/** One agent's account under a profile. `sameAccountAs` is set when an
 * earlier profile in the view already shows this exact account: the card
 * draws it as a one-line "same account as ■ X" instead of repeating it. */
export interface AccountEntry {
  runtime: PlanUsageRuntime;
  usage: RuntimePlanUsage;
  sameAccountAs?: string;
}

export interface ProfileGroup {
  profileId: string;
  active: boolean;
  data: PlanUsageDataState;
  usage: ProfilePlanUsage;
  accounts: AccountEntry[];
}

const RUNTIME_ORDER: PlanUsageRuntime[] = ["claude", "codex"];

function runtimeRank(runtime: string): number {
  const index = RUNTIME_ORDER.indexOf(runtime as PlanUsageRuntime);
  return index === -1 ? RUNTIME_ORDER.length : index;
}

/**
 * The card's groups: the active tab's profile first, then the rest in the
 * profile list's own order. Within a group, Claude before Codex.
 *
 * The same account logged in on two profiles' machines (one Claude login
 * used at home and at work) is one quota, so it is shown in full once — at
 * its first appearance in that order — and as a reference everywhere else.
 * Two accounts are the same only when the relay gave both the same
 * `accountKey` for the same runtime; no key, no match.
 */
export function groupByProfile(
  profileIds: readonly string[],
  byProfile: Readonly<Record<string, ProfilePlanUsage>>,
  activeProfileId: string | null,
): ProfileGroup[] {
  const ordered =
    activeProfileId && profileIds.includes(activeProfileId)
      ? [activeProfileId, ...profileIds.filter((id) => id !== activeProfileId)]
      : [...profileIds];
  const firstSeen = new Map<string, string>();
  return ordered.map((profileId) => {
    const usage = byProfile[profileId] ?? EMPTY_PROFILE_USAGE;
    const data = profileDataState(usage);
    const runtimes = data === "live" || data === "stale" ? [...(usage.runtimes ?? [])] : [];
    runtimes.sort((a, b) => runtimeRank(a.runtime) - runtimeRank(b.runtime));
    const accounts = runtimes.map((entry): AccountEntry => {
      if (!entry.accountKey) return { runtime: entry.runtime, usage: entry };
      const key = `${entry.runtime}:${entry.accountKey}`;
      const owner = firstSeen.get(key);
      if (owner !== undefined) return { runtime: entry.runtime, usage: entry, sameAccountAs: owner };
      firstSeen.set(key, profileId);
      return { runtime: entry.runtime, usage: entry };
    });
    return { profileId, active: profileId === activeProfileId, data, usage, accounts };
  });
}

/** Accounts the card shows in full — the "3 accounts" of its header. A
 * runtime with no login is not an account. */
export function countAccounts(groups: readonly ProfileGroup[]): number {
  return groups.reduce(
    (total, group) =>
      total +
      group.accounts.filter((entry) => !entry.sameAccountAs && entry.usage.status !== "signed_out" && entry.usage.status !== "unknown").length,
    0,
  );
}

export interface ProfileAlert {
  profileId: string;
  level: Exclude<UsageLevel, "neutral">;
}

/**
 * Inactive profiles the status bar should flag: any of their accounts at 80%
 * or more (warn) or spent (limited), the worst one deciding. A repeated
 * account is skipped — its quota is already accounted for where it is shown
 * in full. Cached numbers of an unreachable profile count: an asleep
 * machine's agents spend nothing, and the windows' own reset times still
 * bring a spent one back to 0.
 */
export function otherProfileAlerts(groups: readonly ProfileGroup[], nowMs: number): ProfileAlert[] {
  const alerts: ProfileAlert[] = [];
  for (const group of groups) {
    if (group.active) continue;
    const level = group.accounts
      .filter((entry) => !entry.sameAccountAs)
      .reduce<UsageLevel>((worst, entry) => worseLevel(worst, runtimeLevel(entry.usage, nowMs)), "neutral");
    if (level !== "neutral") alerts.push({ profileId: group.profileId, level });
  }
  return alerts;
}

/** The windows that measure the account itself, for the status bar's text:
 * Claude's account-wide windows (no `limitId`) and Codex's account bucket.
 * Model-scoped windows (`seven_day_opus`, Codex's per-model buckets) stay in
 * the card. Falls back to every window when none qualify, so a reading made
 * only of scoped windows still says something. */
export function accountWindows(views: readonly WindowView[]): WindowView[] {
  const account = views.filter((view) => view.limitId === undefined || view.limitId === "codex");
  return account.length > 0 ? account : [...views];
}

/** When a spent runtime can work again: the latest reset among its spent
 * windows — while any one of them is at 100%, the agent refuses. `null`
 * when nothing is spent, or no spent window has a reset time. */
export function spentUntil(views: readonly WindowView[]): number | null {
  let until: number | null = null;
  for (const view of views) {
    if (view.level !== "limited" || view.resetsAt === null) continue;
    until = until === null ? view.resetsAt : Math.max(until, view.resetsAt);
  }
  return until;
}
