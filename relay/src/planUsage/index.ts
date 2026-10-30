// Public surface of the plan usage module. The types are the contract the
// client mirrors and the later pieces (probes, service, WebSocket) build on;
// import from here, not from the individual files.
export type {
  PlanLabel,
  PlanUsageErrorKind,
  PlanUsageRefreshMessage,
  PlanUsageRuntime,
  PlanUsageSource,
  PlanUsageStateMessage,
  PlanUsageStatus,
  PlanWindow,
  RuntimePlanUsage,
} from "./types.js";
export { PLAN_WINDOW_MINS } from "./types.js";

export { clampPercent, epochSecondsToMs, sameResetsAt, snapWindowDuration, sortWindows, windowIdentity } from "./windows.js";

export type { ClaudeRateLimitReading, ClaudeRateLimitStatus } from "./claudeEvent.js";
export { claudeReadingStatus, parseClaudeRateLimitEvent } from "./claudeEvent.js";

export type { CodexAccount, CodexLimitBucket, CodexRateLimits } from "./codexLimits.js";
export {
  CODEX_ACCOUNT_LIMIT_ID,
  classifyCodexRateLimitsError,
  codexLimitsPlanType,
  codexLimitsStatus,
  codexPlanWindows,
  mergeCodexRateLimits,
  parseCodexAccount,
  parseCodexLimitBucket,
  parseCodexRateLimitsRead,
  parseCodexRateLimitsUpdated,
} from "./codexLimits.js";

export type { ClaudePlanInput } from "./planLabel.js";
export { capitalizePlanValue, claudePlanLabel, codexPlanLabel } from "./planLabel.js";

export type { PlanUsageReading } from "./ingest.js";
export {
  PROBE_EDGE_MARGIN_MS,
  SAME_WINDOW_TOLERANCE_MS,
  emptyPlanUsage,
  fiveHourWindow,
  ingestAuthState,
  ingestError,
  ingestReading,
  isWindowExpired,
  presentPlanUsage,
  shouldAutoProbe,
} from "./ingest.js";
