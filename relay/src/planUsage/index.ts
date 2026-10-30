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

export type { AccountKeyKind, ClaudeFileIdentity } from "./accountKey.js";
export {
  ACCOUNT_KEY_HEX_LENGTH,
  ACCOUNT_SALT_BYTES,
  ACCOUNT_SALT_FILE,
  DEFAULT_ACCOUNT_SALT_DIR,
  accountKeyForLog,
  claudeAccountKey,
  codexAccountKey,
  deriveAccountKey,
  loadOrCreateAccountSalt,
} from "./accountKey.js";

export type { ClaudeAccountFile, ClaudeTiers, ReadClaudeAccountFileOptions } from "./claudeTier.js";
export { claudeAccountFilePath, createClaudeAccountFileReader, extractClaudeAccount } from "./claudeTier.js";

export { codexHomeDir, hasCodexAuthFile } from "./codexHome.js";

export type { PlanUsageCaptureEvent, PlanUsageCaptureListener } from "./capture.js";
export { CODEX_RATE_LIMITS_UPDATED_METHOD, PlanUsageCapture, planUsageCapture, planUsageRuntimeOf } from "./capture.js";

export type { AutoReadContext, ClaudeAutoContext, ClaudeAutoDecision } from "./scheduler.js";
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CLAUDE_PROBE_INTERVAL_MS,
  CODEX_READ_INTERVAL_MS,
  CONNECT_FLOOR_MS,
  SCHEDULER_TICK_MS,
  activityThreshold,
  backoffDelay,
  claudeWindowActive,
  decideClaudeAuto,
  decideCodexAuto,
  nextClaudeAutoRefreshAt,
  nextCodexAutoRefreshAt,
} from "./scheduler.js";

export { claudeProjectsDir, hasClaudeActivitySince } from "./transcriptActivity.js";

export type {
  CreatePlanUsageServiceOptions,
  PlanUsageListener,
  PlanUsageRefreshOptions,
  PlanUsageServiceDeps,
  PlanUsageSnapshotStore,
} from "./service.js";
export {
  PLAN_USAGE_PROBE_ENV,
  PlanUsageService,
  createFilePlanUsageStore,
  createPlanUsageService,
  isPlanUsageProbeEnabled,
  planUsagePathFor,
} from "./service.js";
