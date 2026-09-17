// Everything here is Claude-`--permission-prompt-tool`/`--mcp-config`-shaped
// — moved out of session/turnMessages.ts (where it used to sit) because
// session/ reaching into CLI-flag-shaped data is exactly the boundary
// docs/invariants.md already calls out. `SharedSession` composes these into
// a turn without needing to know any of this file's vocabulary; Fase 10's
// Codex driver never imports this file at all (native approval routes
// through TurnHost, not an MCP bridge).
import { CHOICE_ALLOWED_TOOL, CHOICE_MCP_SERVER_NAME, CHOICE_USAGE_HINT, type ChoiceAnswer, type ChoiceQuestion } from "../../../bridges/mcpBridge.js";
import { PERMISSION_MCP_SERVER_NAME, PERMISSION_PROMPT_TOOL, type PermissionDecision } from "../../../bridges/permissionBridge.js";
import type { McpSpawnConfig } from "./session.js";

/** Human-readable summary of a tool call for the generic
 * approval question in `buildApprovalQuestion` below. Only the field that
 * best identifies the action is picked per tool; anything unrecognized
 * falls back to a truncated JSON dump so no call is ever unreadable, just
 * less nicely formatted than the common cases. */
export function describeToolCall(toolName: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const field = (name: string): string | undefined => {
    const value = record?.[name];
    return typeof value === "string" ? value : undefined;
  };
  switch (toolName) {
    case "Bash":
      return field("command") ?? JSON.stringify(input);
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return field("file_path") ?? field("notebook_path") ?? JSON.stringify(input);
    default: {
      const json = JSON.stringify(input);
      return json.length > 200 ? `${json.slice(0, 200)}…` : json;
    }
  }
}

/** The two answers a permission prompt accepts. Ids, not labels: the label is
 * whatever the client chose to print, and matching the verdict against it is
 * what kept this one prompt untranslatable while the rest of the UI moved. */
export const APPROVE_OPTION_ID = "approve";
export const DENY_OPTION_ID = "deny";

/**
 * Builds the yes/no a blocked tool call is waiting on. Two audiences, on
 * purpose: `approval` and the option ids are for the person — the client
 * composes the question and the buttons from the parts, in whatever language
 * is selected — while `question` and the labels are the same thing in English,
 * for a client too old to know about `approval`.
 *
 * Exported so it can be tested: the real path here needs a `claude` child
 * speaking MCP's Streamable HTTP transport mid-turn, which the fake claude
 * fixture doesn't implement, so no integration test can reach it.
 */
export function buildApprovalQuestion(toolName: string, input: unknown): ChoiceQuestion {
  const isExitPlanMode = toolName === "ExitPlanMode";
  const detail = isExitPlanMode ? "" : describeToolCall(toolName, input);
  return {
    question: isExitPlanMode
      ? "The model wants to leave Plan mode and start executing. Approve?"
      : `The model wants to run \`${toolName}\`: ${detail}. Approve?`,
    approval: { tool: toolName, detail },
    options: [
      { id: APPROVE_OPTION_ID, label: "Approve" },
      { id: DENY_OPTION_ID, label: "Deny" },
    ],
  };
}

/**
 * Reads the verdict out of the answer. Anything that isn't an explicit
 * approval is a refusal — a malformed answer, an empty one, or free text that
 * matched no option must never be read as "go ahead", since what is waiting
 * on it is a command about to run on the user's machine.
 */
export function isApproved(answers: ChoiceAnswer[]): boolean {
  return answers[0]?.selected.includes(APPROVE_OPTION_ID) ?? false;
}

/**
 * Turns a verdict into the `--permission-prompt-tool` response the CLI
 * expects — pure (no waiting, no broadcast), so `SharedSession.checkPermission`
 * only has to orchestrate getting `approved` from a human, not build the
 * decision itself. `ExitPlanMode` keeps its own wording (a mode transition
 * reads differently than "approve this action"); everything else gets the
 * generic refusal. An approved decision passes `input` through unchanged —
 * the relay never modifies what the model asked to do, only allows or blocks it.
 */
export function buildPermissionDecision(toolName: string, input: unknown, approved: boolean): PermissionDecision {
  if (approved) return { behavior: "allow", updatedInput: input };
  const isExitPlanMode = toolName === "ExitPlanMode";
  return {
    behavior: "deny",
    message: isExitPlanMode ? "O usuário optou por continuar no modo Plan." : "O usuário recusou a execução.",
  };
}

/** The CLI's own idle timeout for an `"http"` MCP server the child never
 * hears back from before a human answers — see `buildMcpSpawnConfig`'s doc
 * comment for why this is a known-ineffective override kept anyway. */
const HUMAN_RESPONSE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the `--mcp-config`/`--allowedTools`/`--permission-prompt-tool`/
 * `--disallowedTools`/`--append-system-prompt` bundle for a turn, from
 * nothing but whether each bridge is registered this turn and the token it
 * handed back — `SharedSession.runTurn` owns the actual "which mode gets
 * which server" decision (`choiceToken`/`permissionToken` are already
 * `undefined` for a mode that shouldn't get that bridge by the time they
 * reach here), this function only turns "registered or not" into CLI args.
 * `undefined` when neither bridge is registered (`bypassPermissions` with no
 * choice bridge either) — the CLI gets no `--mcp-config` at all in that
 * case, same as before this feature existed.
 *
 * Registered fresh for every turn (not once per session): the token is the
 * endpoint's only auth, and a turn that ends (however it ends — success,
 * error, or `stopTurn`) must not leave a token alive that a since-exited
 * `claude` child could no longer call anyway.
 *
 * `permissionToken`'s server (`anywh-permission`) still waits on a real
 * human (an approve/deny decision) with no bytes sent back until that
 * happens — from the CLI's point of view that's indistinguishable from a
 * hung connection. Real finding (2026-09-09): the CLI's own default idle
 * timeout for `"http"` MCP servers is 5 minutes (undocumented in `--help`,
 * confirmed against the CLI's own docs), well inside how long a human can
 * plausibly take to notice a prompt and answer it — the panel was observed
 * disappearing out from under the human mid-decision. `timeout` here is
 * meant to override that per server (also acts as a floor under the idle
 * timeout, per the same docs).
 *
 * UPDATE (2026-09-09): this override does NOT actually work — confirmed
 * live, a call that never resolves still errors out with "The operation
 * timed out" at ~6 minutes with this field set to 24h, matching a known
 * upstream regression (per-server `timeout` silently ignored for HTTP
 * transport since CLI v2.1.113). Two more mitigations were tried and also
 * failed live at the same ~6-minute mark: `requestTimeout = 0` on both of
 * this relay's own HTTP servers (server.ts, ruling out our own server as the
 * culprit) and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` as an env var on the
 * child (host/childEnv.ts's `buildChildEnv`, a separate code path from this
 * JSON field, confirmed reaching the child's env and still not preventing
 * the timeout). All three are kept anyway — they cost nothing and may start
 * working if Anthropic fixes the underlying CLI bug(s) — but treat this as
 * an OPEN, unfixed limitation of the CLI itself, not a solved problem:
 * permission-approval will still degrade to an auto-deny after ~6 minutes of
 * no human answer (`sendTurn` surfaces that as a normal tool error, same as
 * any other `claude` failure — the turn doesn't hang, it just can't get the
 * approval it asked for).
 *
 * `choiceToken`'s server (`anywh-choice`) no longer needs any of this:
 * `presentChoice` (mcpBridge.ts's `ChoiceHost`) replies to `present_choice`
 * immediately now (the deferred lifecycle this feature introduced), so
 * there's nothing left for the CLI's idle/wall-clock timeout to ever catch —
 * the call is already done well within the default before either limit
 * could apply. No `timeout` override is set for it below; the field only
 * matters for `permissionToken`.
 *
 * `alwaysLoad` is a separate, CONFIRMED-working fix for a different bug in
 * the same area, unrelated to timeouts, still needed by BOTH servers: the
 * CLI's MCP tool search can leave `present_choice` listed by name only,
 * schema deferred, and a follow-up system-prompt reminder telling the model
 * to `ToolSearch` for it before calling it was observed live to still get
 * skipped — the model had that exact instruction in context and didn't
 * reach for it anyway, a prompt-adherence gap no wording reliably closes.
 * `alwaysLoad: true` sidesteps the model's choice entirely: the CLI docs
 * confirm it keeps a server's tools out of deferral regardless of
 * `ENABLE_TOOL_SEARCH`, so both tools arrive with full schema already
 * loaded, same as a built-in tool — nothing to discover, nothing to forget
 * to search for. Both servers qualify for the doc's own stated use case ("a
 * small number of tools that Claude needs on every turn").
 */
export function buildMcpSpawnConfig(params: {
  choiceToken: string | undefined;
  permissionToken: string | undefined;
  mcpBridgeBaseUrl: string | undefined;
  mcpPermissionBridgeBaseUrl: string | undefined;
  /** Whether the CLI's native `AskUserQuestion` must be disallowed this turn.
   * Deliberately independent from `choiceToken`: in `plan` mode `present_choice`
   * itself can't be registered (the CLI blocks any non-native tool there), but
   * the native tool still needs blocking so the model is forced onto the
   * `planChoiceMarker.ts` text convention instead of a call that silently
   * fails in headless mode — see `McpSpawnConfig.disallowedTools`'s doc
   * comment for the full story. */
  blockAskUserQuestion: boolean;
}): McpSpawnConfig | undefined {
  const { choiceToken, permissionToken, mcpBridgeBaseUrl, mcpPermissionBridgeBaseUrl, blockAskUserQuestion } = params;
  if (!choiceToken && !permissionToken && !blockAskUserQuestion) return undefined;

  const mcpServers: Record<string, { type: "http"; url: string; timeout?: number; alwaysLoad: true }> = {};
  if (choiceToken) {
    mcpServers[CHOICE_MCP_SERVER_NAME] = { type: "http", url: `${mcpBridgeBaseUrl}/${choiceToken}`, alwaysLoad: true };
  }
  if (permissionToken) {
    mcpServers[PERMISSION_MCP_SERVER_NAME] = {
      type: "http",
      url: `${mcpPermissionBridgeBaseUrl}/${permissionToken}`,
      timeout: HUMAN_RESPONSE_TIMEOUT_MS,
      alwaysLoad: true,
    };
  }
  return {
    configJson: JSON.stringify({ mcpServers }),
    allowedTools: choiceToken ? CHOICE_ALLOWED_TOOL : undefined,
    permissionPromptTool: permissionToken ? PERMISSION_PROMPT_TOOL : undefined,
    // Force the model onto our `present_choice` (or, in plan mode, the
    // `planChoiceMarker.ts` text convention) instead of the CLI's own
    // native `AskUserQuestion` — see `McpSpawnConfig.disallowedTools`'s doc
    // comment for why the native one silently fails here.
    disallowedTools: blockAskUserQuestion ? "AskUserQuestion" : undefined,
    extraSystemPrompt: choiceToken ? CHOICE_USAGE_HINT : undefined,
  };
}
