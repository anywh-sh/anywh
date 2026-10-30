// The plan usage model: how much of a subscription's rate-limit windows an
// agent CLI's logged-in account has spent, as the relay reports it to the
// client. This file is the contract the client mirrors
// (client/src/lib/planUsage/model.ts) — change it only additively, since an
// older client reads what a newer relay sends.
//
// Sources and the decisions behind every field: journal/99 §3 and §12
// (workspace-level, not in this repo); docs/ once the feature lands.
//
// Pure: types and constants only.

/** The agent CLIs whose plan usage the relay reads. */
export type PlanUsageRuntime = "claude" | "codex";

/** Canonical window lengths, in minutes. A window is identified by its
 * duration, never by its position or a source-specific name (D2'): Claude's
 * `five_hour`/`seven_day` are converted to these, Codex reports
 * `windowDurationMins` directly. */
export const PLAN_WINDOW_MINS = {
  fiveHour: 300,
  sevenDay: 10080,
  thirtyDay: 43200,
  thirtyOneDay: 44640,
} as const;

/** One rate-limit window. The UI derives its label from `durationMins`
 * (300 → "5h", 10080 → "7d", 43200/44640 → "30d", anything else formatted)
 * and the expected pace from `resetsAt − durationMins`. */
export interface PlanWindow {
  /** Window length in minutes, snapped to the canonical value when within
   * ±1 of one (`PLAN_WINDOW_MINS`). */
  durationMins: number;
  /** 0–100, clamped. A window whose `resetsAt` has passed is reported as 0
   * — never the old percentage (see `presentPlanUsage`). */
  usedPercent: number;
  /** When the window resets, epoch milliseconds; null when unknown. */
  resetsAt: number | null;
  /** Set when the source reports several limits of the same duration: the
   * Codex bucket id (`"codex"`), or a scoped Claude window
   * (`"seven_day_opus"`). Absent for Claude's account-wide windows. */
  limitId?: string;
}

/** What the relay can say about one runtime's plan right now.
 * - `ok`: windows below their limit.
 * - `warning`: the source itself flagged the account as close to a limit
 *   (Claude's `allowed_warning`); the UI shows at least the warning color.
 * - `limited`: a window is exhausted (or the source rejected the account);
 *   `windows` tells which and when it resets.
 * - `signed_out`: the CLI has no login.
 * - `no_subscription`: logged in without a plan (API key, Bedrock…); the
 *   UI shows an "API key" chip instead of bars (D17).
 * - `error`: the last read failed; `windows`/`observedAt` keep the last good
 *   reading, if any.
 * - `unknown`: nothing read yet. */
export type PlanUsageStatus = "ok" | "warning" | "limited" | "signed_out" | "no_subscription" | "error" | "unknown";

/** Where the reading in a `RuntimePlanUsage` came from. `transcript` is a
 * limit refusal Claude Code wrote into a session transcript (only ever
 * "limited until X"). */
export type PlanUsageSource = "turn" | "probe" | "app_server_read" | "app_server_push" | "transcript";

export type PlanUsageErrorKind = "network" | "auth" | "parse" | "unknown";

/** The plan the account is on. Only these two strings reach the client:
 * never the raw tier fields they were derived from. */
export interface PlanLabel {
  /** Raw plan family, lowercased: Claude `subscriptionType` (`"max"`,
   * `"team"`…), Codex `planType` (`"free"`, `"plus"`…). */
  family: string;
  /** Final UI label: `"Max 20x"`, `"Team"`, `"Pro Lite"`. */
  label: string;
  /** Present only when the optional `~/.claude.json` tier refined the label
   * (`"Max"` → `"Max 5x"`). */
  variantSource?: "claude_json_tier";
}

export interface RuntimePlanUsage {
  runtime: PlanUsageRuntime;
  status: PlanUsageStatus;
  /** 1..N windows, ascending by duration. Empty when nothing is known. */
  windows: PlanWindow[];
  /** Absent = hide the plan chip. */
  plan?: PlanLabel;
  /** Opaque account id (16 hex) for deduplicating the same account across
   * profiles in the client; never an e-mail or UUID. */
  accountKey?: string;
  /** When the relay last got a reading, epoch ms; null = never. */
  observedAt: number | null;
  source?: PlanUsageSource;
  /** Next automatic read, epoch ms; null = stopped (window expired,
   * account limited, or no client connected). */
  nextAutoRefreshAt?: number | null;
  error?: { kind: PlanUsageErrorKind };
  /** A read of this runtime (Claude probe, Codex pull) is in flight. Sent
   * with a state pushed when it starts and cleared by the one pushed when it
   * ends; absent = nothing in flight. A relay without this field never sets
   * it, so a client reads its absence as "not reading". */
  reading?: boolean;
  /** When the read in flight started, epoch ms (relay clock); set only with
   * `reading: true`. A Claude probe takes a few seconds, up to its 30 s
   * timeout. */
  readingSince?: number;
}

/** Relay → client: the full state of every installed runtime, sent on
 * connect and whenever it changes. */
export interface PlanUsageStateMessage {
  type: "plan_usage_state";
  runtimes: RuntimePlanUsage[];
  /** When the relay built this message, epoch ms. */
  observedAt: number;
}

/** Client → relay. `force: true` is the refresh button: it always reads,
 * even when that opens a new Claude window (D13). `force: false` is opening
 * the card: Codex is re-read, Claude answers from the cache. */
export interface PlanUsageRefreshMessage {
  type: "plan_usage_refresh";
  /** Absent = every runtime. */
  runtime?: PlanUsageRuntime;
  force: boolean;
}
