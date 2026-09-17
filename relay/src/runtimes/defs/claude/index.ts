// The only file under this folder anything outside it may import — the
// rest is Claude's private on-disk transcript format and process-spawning
// detail, not something `session/` or `server.ts` should reach into
// directly. Re-exports exactly what's consumed today; grows as the actual
// `AgentRuntimeDef` contract lands.
export { ClaudeSession, CLAUDE_AGENT_ENV_OVERRIDES, isMainThreadEvent, type ClaudeEvent, type McpSpawnConfig } from "./session.js";
export { readHistoryFromTranscript, transcriptPath } from "./transcriptReader.js";
export { forkTruncatedTranscript } from "./transcriptFork.js";
export { claudeRuntimeDef } from "./def.js";
export {
  APPROVE_OPTION_ID,
  DENY_OPTION_ID,
  buildApprovalQuestion,
  buildMcpSpawnConfig,
  buildPermissionDecision,
  describeToolCall,
  isApproved,
} from "./mcpSpawnConfig.js";
