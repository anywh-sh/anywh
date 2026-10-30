// Recorded payloads for the plan usage tests, redacted: ids are
// placeholders, the e-mail is a reserved-domain stand-in. Kept as a module
// rather than files under tests/fixtures/ so the pure tests stay free of
// `fs` (see .anywh/skills/tests/SKILL.md).
//
// Sources (ENG-32 investigation, outside this repo):
// - Claude Code 2.1.303, stream-json `rate_limit_event`;
// - codex-cli 0.154.0, app-server `account/read`,
//   `account/rateLimits/read` and `account/rateLimits/updated`.
// Anything marked SYNTHETIC was not observed: it follows the generated
// bindings only.

/** Claude, Max plan, mid-window (`allowed`). */
export const CLAUDE_EVENT_ALLOWED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1793333400,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.63, resetsAt: 1793333400 },
      seven_day: { utilization: 0.19, resetsAt: 1793746800 },
    },
  },
  uuid: "00000000-0000-4000-8000-000000000001",
  session_id: "00000000-0000-4000-8000-000000000002",
};

/** Claude, account at its 5h limit: the probe's reply. */
export const CLAUDE_EVENT_REJECTED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected",
    resetsAt: 1793333400,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 1, resetsAt: 1793333400 },
      seven_day: { utilization: 0.22, resetsAt: 1793746800 },
    },
  },
  uuid: "00000000-0000-4000-8000-000000000003",
  session_id: "00000000-0000-4000-8000-000000000004",
};

/** SYNTHETIC: `allowed_warning` with `surpassedThreshold` and a model-scoped
 * weekly window — both exist in the binary, neither was ever observed. */
export const CLAUDE_EVENT_WARNING_SCOPED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    surpassedThreshold: 0.8,
    resetsAt: 1793333400,
    rateLimitType: "seven_day",
    unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: 1793333400 },
      seven_day: { utilization: 0.83, resetsAt: 1793746800 },
      seven_day_opus: { utilization: 0.91, resetsAt: 1793746800 },
    },
  },
};

/** Codex, free plan, quota exhausted: one 30-day window. */
export const CODEX_RATE_LIMITS_READ_FREE = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1795025523 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    spendControlReached: false,
    planType: "free",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1795025523 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null,
      spendControlReached: false,
      planType: "free",
      rateLimitReachedType: "rate_limit_reached",
    },
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: "redacted-account-id",
  rateLimitUpsell: {
    banner_type: "free_trial_rate_limit_reached",
    title: "You're out of Codex messages",
    reset_at: 1795025523,
  },
};

/** SYNTHETIC: a paid plan (5h + weekly), from the bindings — not measured.
 * Windows deliberately out of order and off by one minute. */
export const CODEX_RATE_LIMITS_READ_PLUS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 40, windowDurationMins: 10081, resetsAt: 1793800000 },
    secondary: { usedPercent: 12, windowDurationMins: 299, resetsAt: 1793340000 },
    planType: "plus",
    rateLimitReachedType: null,
  },
};

/** Codex push during a turn on an exhausted account: a sparse bucket with
 * every field null. */
export const CODEX_RATE_LIMITS_UPDATED_EMPTY = {
  rateLimits: {
    limitId: "premium",
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  },
};

export const CODEX_ACCOUNT_READ_CHATGPT = {
  account: { type: "chatgpt", email: "redacted@example.invalid", planType: "free" },
  requiresOpenaiAuth: true,
};

export const CODEX_ERROR_SIGNED_OUT = { code: -32600, message: "codex account authentication required to read rate limits" };
export const CODEX_ERROR_API_KEY = { code: -32600, message: "chatgpt authentication required to read rate limits" };
