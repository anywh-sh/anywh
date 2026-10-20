// Spawn shape for a long-lived `claude` process driven over stream-json —
// one process per agent, many turns, as the agent host runs it — as opposed
// to session.ts's one `claude -p <text>` process per turn.
//
// Measured against Claude Code 2.1.303:
//   - `-p --input-format stream-json --output-format stream-json --verbose`
//     keeps the process alive across turns: each user message written to
//     stdin starts a turn (a `system`/`init` event, then the usual stream,
//     then one `result`), and the process waits for the next one. Hours of
//     turns, including an automatic context compaction, ran in one process
//     with one session id.
//   - A message written while a turn is in flight is NOT queued as the next
//     turn: the CLI folds it into the turn in progress at its next tool
//     boundary ("steering"), and the turn ends with a single `result`.
//   - The `interrupt` control request ends the turn in flight with an error
//     `result` (`terminal_reason: "aborted_tools"` or similar) and leaves the
//     process alive for the next turn. It kills a foreground shell command and
//     a native subagent; a shell command started in the background survives.
//   - Closing stdin when no turn is in flight makes the process exit; the
//     session is resumable later with `--resume <session_id>` (checked after
//     15 and 65 minutes).
//   - `--append-system-prompt` is only honored on a session's first request;
//     on `--resume` the original text stays in effect.
//
// Pure: builds argv and stdin lines, spawns nothing.
import { AGENT_WORKER_SETTING_SOURCES } from "./agentWorker.js";
import { CLAUDE_AGENT_ENV_OVERRIDES, CLAUDE_AGENT_WORKER_ENV, toClaudeMode, type ClaudePermissionMode } from "./session.js";

export interface PersistentClaudeSpec {
  readonly model?: string;
  readonly effort?: string;
  /** Opaque mode id, narrowed to Claude's own four. Default `default`. */
  readonly permissionMode?: string;
  /** Only takes effect when the session is new (see above). */
  readonly appendSystemPrompt?: string;
  readonly allowedTools?: string;
  readonly disallowedTools?: string;
  readonly permissionPromptTool?: string;
  /** Inherits the user's MCP servers but not their plugins, skills or hooks
   * (agentWorker.ts). */
  readonly agentWorker: boolean;
  /** Partial-message deltas on stdout. Default on. */
  readonly partialMessages?: boolean;
}

export interface PersistentLaunch {
  /** A file holding the `--mcp-config` payload (never inline: it can carry
   * the user's server secrets and bridge tokens). */
  readonly mcpConfigPath?: string;
  readonly resumeSessionId?: string;
}

export function buildPersistentArgs(spec: PersistentClaudeSpec, launch: PersistentLaunch): string[] {
  const mode: ClaudePermissionMode = toClaudeMode(spec.permissionMode ?? "default");
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(spec.partialMessages === false ? [] : ["--include-partial-messages"]),
    ...(spec.appendSystemPrompt ? ["--append-system-prompt", spec.appendSystemPrompt] : []),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    ...(mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode]),
    ...(spec.agentWorker ? ["--setting-sources", AGENT_WORKER_SETTING_SOURCES] : []),
    ...(launch.mcpConfigPath ? ["--mcp-config", launch.mcpConfigPath] : []),
    ...(spec.allowedTools ? ["--allowedTools", spec.allowedTools] : []),
    ...(spec.permissionPromptTool ? ["--permission-prompt-tool", spec.permissionPromptTool] : []),
    ...(spec.disallowedTools ? ["--disallowedTools", spec.disallowedTools] : []),
    ...(launch.resumeSessionId ? ["--resume", launch.resumeSessionId] : []),
  ];
}

/** Env overrides for a persistent process: same as a turn's, plus the
 * background-traffic opt-outs for an agent worker. */
export function persistentEnvOverrides(agentWorker: boolean): Readonly<Record<string, string>> {
  return agentWorker ? { ...CLAUDE_AGENT_ENV_OVERRIDES, ...CLAUDE_AGENT_WORKER_ENV } : CLAUDE_AGENT_ENV_OVERRIDES;
}

/** One user turn (or, mid-turn, a steering message) as a stdin line. */
export function encodeUserMessage(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

/** Ends the turn in flight without ending the process. */
export function encodeInterrupt(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}
