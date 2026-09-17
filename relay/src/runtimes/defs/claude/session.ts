import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { AGENT_BIN, EXTRA_PATH_DIRS, stripBilledCredentials } from "../../executables.js";
import { buildChildEnv } from "../../../host/childEnv.js";
import { PLAN_MODE_CHOICE_MARKER_PROMPT } from "../../../bridges/planChoiceMarker.js";
// Known reverse-direction dependency, surfaced by turning on the boundary
// lint (not by this file changing): a def reaching into session/ for two
// types it should be the one describing.
// eslint-disable-next-line import-x/no-restricted-paths
import type { ContextUsage, ModelChoice } from "../../../session/sessionStore.js";

/** Claude's own permission-mode vocabulary — this def's answer to
 * `PermissionPolicy<TSettings>` (runtimes/types.ts), not borrowed from
 * `session/sessionStore.ts` anymore (that file's `PermissionMode` is an
 * opaque per-agent string; conflating the two names is exactly the confusion
 * that motivated splitting them). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Total narrowing from the session's opaque mode id down to this CLI's four
 * literals. The fallback branch is unreachable in practice —
 * `SharedSession.setPermissionMode` never lets an id through that this def's
 * own `permissions.modesFor` didn't offer — but this file has no such
 * guarantee of its own to lean on, and a spawn should never carry
 * `--permission-mode undefined`. */
export function toClaudeMode(id: string): ClaudePermissionMode {
  return id === "default" || id === "acceptEdits" || id === "plan" || id === "bypassPermissions" ? id : "default";
}

// A turn = a `claude -p` process. Continuity across turns comes from
// `--resume <session_id>`, not from keeping a process alive.
//
// A billed credential is always removed from the child process's environment
// (`BILLED_CREDENTIAL_VARS`, runtimes/executables.ts): it's the project's golden
// rule — if one leaks, the agent starts billing per token via API instead of
// drawing on the plan its CLI is logged into.

/** Appended to every turn, regardless of the active project's CLAUDE.md — it's
 * a preference of the anywh CLIENT, not of a specific project. Without
 * this, when writing a draft meant to be pasted elsewhere (Slack, email),
 * the model sometimes manually wraps the text every ~80 columns (habit
 * inherited from terminal/commit text) — inside a ``` block that's literal
 * (`pre` preserves `\n`), so instead of a fluid paragraph that the UI wraps
 * on its own by screen width, you end up with a paragraph with line breaks
 * in the middle of sentences. Text kept lean on purpose (~1/3 of the
 * original) — this goes into EVERY turn even when it has nothing to do with
 * drafting text, so the token cost of a more explicit reinforcement wasn't
 * worth it until it showed up again in practice. If it happens again, it
 * can be reinforced even at the cost of more tokens.
 *
 * Second paragraph: each turn is a new `claude -p` process (comment at the
 * top of the file) — the internal record backing `run_in_background`/
 * `BashOutput` lives only in THAT process's memory and disappears when the
 * turn ends. Without this warning, the model promises "I'll run this in the
 * background and let you know when it's done" using that native mechanism
 * (or raw `&`/`nohup`) and the promise never gets kept — a real finding from
 * the user. `anywh-bg` (script in
 * `relay/scripts/`, included in the PATH above) solves this by staying
 * outside the turn's process; `BackgroundJobTracker` (`backgroundJobs.ts`,
 * wired in `sessionManager.ts`) watches for completion and triggers an
 * automatic follow-up turn (`SharedSession.submitBackgroundJobResult`) —
 * the promise below is now genuinely kept, validated
 * end-to-end against the real binary (`relay/scripts/manual/test-background-job.mjs`).
 */
const APPEND_SYSTEM_PROMPT =
  "When writing prose meant to be pasted elsewhere (Slack, email), write each paragraph as one " +
  "continuous line, not manually wrapped at a fixed width.\n\n" +
  "For any command that will keep running after this turn ends (a build, a long test suite, " +
  "anything whose result matters later) and is worth tracking, launch it with `anywh-bg start " +
  '--label "<short description>" --cmd "<full shell command>"` — check on it within this same ' +
  "turn with `anywh-bg status <id>` if useful. Never use `&`, `nohup`, or the Bash tool's own " +
  "`run_in_background` for this: none of those survive past this turn, so any promise to 'check " +
  "back' or 'let you know' made through them is always broken. Once launched with `anywh-bg`, " +
  "you don't need to wait for it or keep polling before ending your turn — when it finishes, you " +
  "will automatically get a new turn reporting the result, which the user is notified about. You " +
  "can tell them that.";

// Real-session finding (2026-09-09): the per-server `timeout` field in
// `--mcp-config` (sharedSession.ts, mcpServers) is a documented, confirmed
// regression in this CLI generation — silently ignored for `"http"`-type
// servers, which is exactly `anywh-permission`'s transport
// (permissionBridge.ts; `anywh-choice`, mcpBridge.ts, no longer needs it
// at all — its `tools/call` replies immediately now, see the "deferred
// lifecycle" comment on `SharedSession.presentChoice`). Verified live: a
// never-resolving `checkPermission` call still errored with "The
// operation timed out" at ~6 minutes with that field set to 24h.
// `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` isn't documented as broken the same
// way, so set to `0` here too (disables the check entirely, not just
// raises it) as an env var instead — a separate code path in the CLI from
// the JSON field, and confirmed via a debug log to actually reach the
// child's env this time. It STILL didn't help: same live test, same ~6
// minute failure. Kept anyway (harmless, forward-compatible if the
// underlying CLI bug ever gets fixed) but this is an open, unresolved
// upstream limitation for the permission-approval path specifically, not
// something this env var actually fixes today. Applies to every child built
// with this def's env (this turn's `claude -p`, and the interactive
// terminal in terminalSession.ts) — it's not scoped to a single MCP server
// (it can't be, it's a process-wide env var), but it's harmless outside a
// `checkPermission` call actually waiting on a human, so no reason to scope
// it tighter.
export const CLAUDE_AGENT_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
};

export interface ClaudeEvent {
  type: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  /** On `type: "assistant"` this is a genuine field the CLI itself stamps on
   * every stream-json line (verified against real `claude -p --output-format
   * stream-json` output and the on-disk transcript) — present both live and
   * on replay. On `type: "user_prompt"` (synthetic, never comes from the
   * CLI's stdout) it's ISO from the actual `.jsonl` line when rebuilding
   * history, or absent in the live broadcast to other devices —
   * whoever sent the message already knows the click's own time, doesn't
   * depend on this. */
  timestamp?: string;
  [key: string]: unknown;
}

export interface ClaudeSessionOptions {
  /** Overrides the child process's $HOME — used for per-profile isolation. */
  homeOverride?: string;
  /** Seeds the session_id from what `SessionStore` persisted to disk.
   * Without this, a relay restart would lose
   * `--resume` continuity even with the Claude Code session intact. */
  initialSessionId?: string;
}

/** Pre-built by the caller (`SharedSession`, which owns the "which mode gets
 * which MCP server" decision and the actual MCP server
 * registry) — kept as opaque already-formed CLI arg values here, same as
 * every other spawn parameter, so this file stays a plain spawn wrapper that
 * doesn't need to know anything about MCP, choice prompts, or permission
 * approval. `allowedTools` (the `present_choice` tool, active outside `plan`
 * mode) and `permissionPromptTool` (the `--permission-prompt-tool`
 * bridge, active outside `bypassPermissions`) are independent CLI
 * flags and both fields may be set at once — validated against the real
 * binary that the CLI accepts both together in the same spawn (the modes
 * where both apply, `default`/`acceptEdits`, are exactly where both bridges
 * are registered, see `SharedSession.runTurn`). */
export interface McpSpawnConfig {
  /** Full `--mcp-config` JSON payload, ready to pass through. */
  configJson: string;
  /** Full `--allowedTools` value (comma-separated is accepted by the CLI). */
  allowedTools?: string;
  /** Tool name to pass to `--permission-prompt-tool` — the
   * CLI calls this tool for every action that would otherwise need
   * approval, instead of auto-denying. */
  permissionPromptTool?: string;
  /** Full `--disallowedTools` value. Used to block the CLI's own native
   * `AskUserQuestion` whenever `present_choice` is registered as its
   * replacement, or whenever plan mode is active (`SharedSession.runTurn`) —
   * without this the model is free to call `AskUserQuestion`, and it never
   * gets a real answer channel in headless, so a call to it silently fails
   * and the model just paraphrases the question as plain text instead of
   * rendering the picker UI (confirmed live: this is exactly what happened
   * instead of the `present_choice` panel opening). In plan mode specifically,
   * `present_choice` itself can't be registered either (the CLI blocks any
   * non-native tool categorically there), so this flag is what forces the
   * model onto the `planChoiceMarker.ts` text convention instead. */
  disallowedTools?: string;
  /** Extra text folded into `--append-system-prompt` for this turn only —
   * currently just `CHOICE_USAGE_HINT` (`mcpBridge.ts`) when `present_choice`
   * is registered, nudging the model to actually reach for it instead of
   * defaulting to plain-text prose for a closed question. Kept opaque here
   * for the same reason as the rest of this interface: this file stays a
   * plain spawn wrapper, `SharedSession` owns what the text actually says. */
  extraSystemPrompt?: string;
}

/**
 * Builds the argv for a `claude -p` turn, minus the MCP flags
 * (`--mcp-config`/`--allowedTools`/`--permission-prompt-tool`/
 * `--disallowedTools`) and `--resume` — both stay in `sendTurn` because they
 * depend on state this function doesn't have: which MCP bridges to register
 * (`SharedSession`'s decision, passed in as an opaque `McpSpawnConfig`) and
 * the session's current `sessionId` (this class's own field, not an
 * argument). `extraSystemPrompt` is the one piece of `McpSpawnConfig` this
 * function does need — not the whole object, just the text fragment it
 * folds into `--append-system-prompt` — so the caller passes
 * `mcp?.extraSystemPrompt` instead of `mcp` itself. Exported so
 * `runtimes/defs/claude/def.ts`'s `exec.buildArgs` can reuse it; see that
 * file's comment for the gap this leaves (a real engine would need
 * `TurnContext` to carry MCP config and `extraSystemPrompt` too).
 */
export function buildTurnArgs(text: string, permissionMode: ClaudePermissionMode, model: ModelChoice | undefined, extraSystemPrompt?: string): string[] {
  return [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt",
    // The marker convention is only relevant (and only ever
    // requested) in `plan` mode: it's the fallback for the one mode where
    // the real `present_choice` MCP tool can't be offered at all, so
    // appending it in every other mode would just be dead weight on every
    // spawn for nothing. `extraSystemPrompt` and the plan-mode marker never
    // coexist in practice (`present_choice` is never registered in `plan`
    // mode, `SharedSession.runTurn`), but both are folded in here
    // regardless so this stays correct if that changes.
    [APPEND_SYSTEM_PROMPT, permissionMode === "plan" ? PLAN_MODE_CHOICE_MARKER_PROMPT : undefined, extraSystemPrompt]
      .filter(Boolean)
      .join("\n\n"),
    ...(model ? ["--model", model] : []),
    // `bypassPermissions` is the historical default mode (the only one
    // that existed before the mode became selectable) — it
    // stays on the dedicated flag because that's the way, tested against
    // the real binary, to avoid a tool touching a new path (e.g. a
    // freshly uploaded image) getting stuck asking for approval that
    // nobody can give in a non-interactive process (real finding while
    // testing image upload). It's also the only mode that never
    // gets `permissionPromptTool` (`SharedSession.runTurn`) — every
    // other mode genuinely can pause a turn waiting on a
    // human's approval, by design; that's the whole point of the flag.
    ...(permissionMode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", permissionMode]),
  ];
}

export interface SendTurnResult {
  /** `true` when the turn ended because `stop()` was called, not because
   * `claude` actually finished or errored. */
  stopped: boolean;
  /** `undefined` if the turn didn't get to produce a `result` with the
   * expected fields (e.g. error before any API call) — in that case the
   * caller should keep the last known value, not reset it. */
  contextUsage?: ContextUsage;
  /** Text of the last assistant response on the main thread (doesn't include
   * subagents, same filter as `isMainThreadEvent`) — used only to feed the
   * next-message suggestion generator (suggestionGenerator.ts).
   * `undefined` if the turn didn't produce any text block (e.g. only
   * tool_use before being interrupted). */
  lastAssistantText?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/** `true` when every block in `content` is a `tool_result` — used to tell a
 * genuine tool-result-bearing `user` event apart from synthetic noise that
 * the CLI also emits with `type: "user"` on the same stdout: `isMeta`
 * reminders/caveats, and (notably) a skill's full instructions being loaded
 * into context — the `Skill` tool's own `tool_result` is a short ack
 * ("Launching skill: X"), immediately followed by a SEPARATE `user` event
 * carrying the skill's whole body as a plain `text` block. Exported —
 * `transcriptReader.ts` uses the same criterion when rebuilding history from
 * disk (where this shape is already dropped); `sendTurn` below applies it
 * live so a skill invocation doesn't get displayed as if it were the agent's
 * own message. */
export function isToolResultOnly(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result")
  );
}

interface ResultUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ModelUsageEntry {
  contextWindow?: number;
}

function usageTokenTotal(usage: ResultUsage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/**
 * `true` only for the specific error text the CLI emits when `--resume`
 * itself is broken — the session's `.jsonl` is gone or was never valid
 * (confirmed against the real binary: "No conversation found with session
 * ID: <id>" and "No conversation found to continue"). This is the ONLY case
 * where dropping `sessionId` is correct, so the next turn starts a fresh
 * conversation instead of repeating the same failure forever (the original
 * reason for clearing on error at all — an orphaned session_id
 * after a credentials bug).
 *
 * Every other error `sendTurn` can surface — hitting the 5-hour/weekly usage
 * limit, the API being overloaded, a network hiccup — is transient and says
 * nothing about the session being invalid. Treating those the same way was a
 * real bug: the conversation was still perfectly resumable, but the next
 * turn went out without `--resume` anyway, so the user lost all context the
 * moment the limit reset or the API recovered, indistinguishable from a
 * manual `/clear`.
 */
export function isSessionInvalidError(message: string): boolean {
  return /no conversation found/i.test(message);
}

/**
 * `true` only for `assistant` events on the conversation's main thread —
 * subagents (`Task`) also emit `assistant` events on the same stdout, but
 * with `parent_tool_use_id` pointing at the `tool_use` that triggered them
 * (confirmed by running a real turn with a subagent: its event had
 * `cache_read_input_tokens: 0` — isolated context, starting from zero —
 * quite different from the main thread). Without this filter, a subagent's
 * usage (which can read large files on its own) contaminates the main
 * thread's number.
 */
export function isMainThreadEvent(event: ClaudeEvent): boolean {
  return event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;
}

/**
 * Builds context usage from two complementary sources: `usage` comes from
 * the LAST `assistant` event on the main thread seen in the turn (a single
 * Messages API response — same semantics as Claude Code's official
 * statusline `current_usage`), and `contextWindowSize` comes from
 * `modelUsage[model]` in the turn's ending `result` event — real data from
 * the CLI for that account (e.g. extended 1M context), never a static table
 * of ours.
 *
 * Important: the top-level fields of `result.usage` itself (and
 * `result.usage.iterations`) are aggregates that sum EVERYTHING that ran in
 * the turn, including subagents — tested against a real session and against
 * a turn with a subagent, both inflated the total well beyond what the main
 * thread actually had in context (>100% in a session that hadn't even used
 * 40% of the real limit). That's why this code never reads `result.usage`
 * for tokens — only for `modelUsage` (which is a static property of the
 * model, not a counter, and doesn't suffer from this problem).
 */
export function extractContextUsage(
  resultEvent: ClaudeEvent,
  model: string | undefined,
  lastMainThreadUsage: ResultUsage | undefined,
): ContextUsage | undefined {
  if (!lastMainThreadUsage) return undefined;
  const modelUsage = resultEvent.modelUsage as Record<string, ModelUsageEntry> | undefined;
  if (!modelUsage) return undefined;
  const modelKey = (model && model in modelUsage ? model : undefined) ?? Object.keys(modelUsage)[0];
  const entry = modelKey ? modelUsage[modelKey] : undefined;
  if (!modelKey || !entry?.contextWindow) return undefined;
  return {
    model: modelKey,
    contextWindowSize: entry.contextWindow,
    usedTokens: usageTokenTotal(lastMainThreadUsage),
  };
}

export class ClaudeSession {
  private sessionId: string | undefined;
  private currentChild: ChildProcessWithoutNullStreams | undefined;
  private stopRequested = false;

  constructor(private readonly options: ClaudeSessionOptions = {}) {
    this.sessionId = options.initialSessionId;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** `/clear` — doesn't run anything on `claude`, just drops the
   * local continuity: the next `sendTurn` won't carry `--resume`, so it
   * genuinely starts a new conversation on the CLI side, without spending a
   * process/turn just to "tell" it about that. */
  resetSessionId(): void {
    this.sessionId = undefined;
  }

  /** Message editing — after `transcriptFork.ts` writes a new
   * truncated `.jsonl`, the next `sendTurn` needs to `--resume` with that
   * new id, not the old one (which still has the edited message and
   * everything that came after it). */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Interrupts the turn in progress, if any — used by the "Stop" button on
   * the client. Tested directly against the binary: `claude -p` catches
   * `SIGINT` and exits with code 0 (doesn't die "raw"), even sending a final
   * `result` with a valid `session_id` even when interrupted mid-stream —
   * `sendTurn` uses `stopRequested` to avoid treating this as a genuine
   * error (which would erase session continuity for nothing).
   */
  stop(): boolean {
    if (!this.currentChild) return false;
    this.stopRequested = true;
    this.currentChild.kill("SIGINT");
    return true;
  }

  async sendTurn(
    text: string,
    cwd: string,
    permissionMode: ClaudePermissionMode,
    model: ModelChoice | undefined,
    onEvent: (event: ClaudeEvent) => void,
    mcp?: McpSpawnConfig,
  ): Promise<SendTurnResult> {
    this.stopRequested = false;
    const args = [
      ...buildTurnArgs(text, permissionMode, model, mcp?.extraSystemPrompt),
      // `mcp` combines whichever of the two independent bridges
      // `SharedSession.runTurn` decided to register for this turn's mode:
      // `allowedTools` for the `present_choice` tool outside `plan` mode
      // (tested that `plan` mode blocks any non-native tool categorically
      // regardless of `--allowedTools`, so it's skipped there), and/or
      // `permissionPromptTool` outside `bypassPermissions` (originally just
      // `plan`'s `ExitPlanMode`, later widened to `default`/
      // `acceptEdits` for every action the CLI itself decides needs
      // approval). Validated against the real binary that both flags
      // coexist fine in the same spawn — `default`/`acceptEdits` pass both.
      ...(mcp
        ? [
            "--mcp-config",
            mcp.configJson,
            ...(mcp.allowedTools ? ["--allowedTools", mcp.allowedTools] : []),
            ...(mcp.permissionPromptTool ? ["--permission-prompt-tool", mcp.permissionPromptTool] : []),
            ...(mcp.disallowedTools ? ["--disallowedTools", mcp.disallowedTools] : []),
          ]
        : []),
    ];
    // If a previous `--resume` failed (invalid session, history not found,
    // etc.), sessionId was already cleared below — the next call
    // automatically starts a new conversation instead of repeating the same
    // error forever.
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const child = spawn(AGENT_BIN, args, {
      env: buildChildEnv(this.options.homeOverride, EXTRA_PATH_DIRS, stripBilledCredentials, CLAUDE_AGENT_ENV_OVERRIDES),
      cwd,
    });
    this.currentChild = child;

    try {
      const spawnError = new Promise<never>((_, reject) => {
        child.on("error", (error) => reject(error));
      });

      let stderrOutput = "";
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrOutput += text;
        console.error("[relay] claude stderr:", text);
      });

      let eventCount = 0;
      let lastErrorResult: string | undefined;
      let lastModel: string | undefined;
      let lastMainThreadUsage: ResultUsage | undefined;
      let contextUsage: ContextUsage | undefined;
      let lastAssistantText: string | undefined;

      const readLines = (async () => {
        const rl = createInterface({ input: child.stdout });
        for await (const line of rl) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as ClaudeEvent;
          eventCount++;
          if (event.type === "user" && !isToolResultOnly((event.message as { content?: unknown } | undefined)?.content)) {
            continue;
          }
          if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
            lastModel = event.model;
          }
          if (event.type === "assistant" && isMainThreadEvent(event)) {
            const message = event.message as { usage?: ResultUsage; content?: ContentBlock[] } | undefined;
            if (message?.usage) lastMainThreadUsage = message.usage;
            // Overwritten on every main-thread assistant event — the last
            // one before `result` is the final response the user saw, which
            // is what matters for the suggestion generator (no need to
            // accumulate every intermediate response in the turn).
            const textBlocks = message?.content?.filter((block) => block.type === "text" && block.text);
            if (textBlocks && textBlocks.length > 0) {
              lastAssistantText = textBlocks.map((block) => block.text).join("\n");
            }
          }
          if (event.type === "result") {
            // Captured whenever present, error or not — a turn interrupted
            // by `stop()` still sends a `result` with a valid `session_id`
            // (tested against the real binary), and without this the
            // session's continuity would be lost for nothing on a stop.
            if (typeof event.session_id === "string") this.sessionId = event.session_id;
            if (event.is_error) {
              lastErrorResult =
                event.errors?.join("; ") || event.result || "erro desconhecido retornado pelo claude";
            }
            contextUsage = extractContextUsage(event, lastModel, lastMainThreadUsage) ?? contextUsage;
          }
          onEvent(event);
        }
      })();

      // Raced against `spawnError` from the start (not awaited on its own
      // first) — a spawn failure (bad `cwd`, missing binary, ...) doesn't
      // reliably emit `close` (a missing executable never does, see
      // tests/spawnFailure.test.ts), so awaiting `close` alone here would
      // leave `spawnError`'s rejection unconsumed for a window with no
      // handler attached — an unhandled-rejection crash that used to take
      // the whole relay process down instead of just failing this turn.
      const exitCode = await Promise.race([
        spawnError,
        new Promise<number | null>((resolve) => {
          child.on("close", (code) => resolve(code));
        }),
      ]);

      await Promise.race([spawnError, readLines]);

      if (lastErrorResult) {
        if (this.stopRequested) return { stopped: true, contextUsage, lastAssistantText };
        if (isSessionInvalidError(lastErrorResult)) this.sessionId = undefined;
        throw new Error(lastErrorResult);
      }
      if (eventCount === 0 || exitCode !== 0) {
        if (this.stopRequested) return { stopped: true, contextUsage, lastAssistantText };
        const message = stderrOutput.trim() || `claude saiu com código ${String(exitCode)} sem produzir nenhum evento`;
        if (isSessionInvalidError(message)) this.sessionId = undefined;
        throw new Error(message);
      }
      return { stopped: false, contextUsage, lastAssistantText };
    } finally {
      this.currentChild = undefined;
    }
  }
}
