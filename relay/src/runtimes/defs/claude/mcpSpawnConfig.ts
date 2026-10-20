// Everything here is Claude-`--permission-prompt-tool`/`--mcp-config`-shaped
// — moved out of session/turnMessages.ts (where it used to sit) because
// session/ reaching into CLI-flag-shaped data is exactly the boundary
// docs/invariants.md already calls out. `SharedSession` composes these into
// a turn without needing to know any of this file's vocabulary; Fase 10's
// Codex driver never imports this file at all (native approval routes
// through TurnHost, not an MCP bridge).
import { CHOICE_ALLOWED_TOOL, CHOICE_MCP_SERVER_NAME, CHOICE_USAGE_HINT, type ChoiceAnswer, type ChoiceQuestion } from "../../../bridges/mcpBridge.js";
import { PERMISSION_MCP_SERVER_NAME, PERMISSION_PROMPT_TOOL, type PermissionDecision } from "../../../bridges/permissionBridge.js";
import type { ToolGrant } from "../../types.js";
import type { McpSpawnConfig } from "./session.js";
import { posix } from "node:path";

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
export function buildApprovalQuestion(toolName: string, input: unknown, agentId?: string): ChoiceQuestion {
  const isExitPlanMode = toolName === "ExitPlanMode";
  const detail = isExitPlanMode ? "" : describeToolCall(toolName, input);
  // A native subagent has no card of its own: its request is shown on the
  // parent session, so say whose it is.
  const who = agentId === undefined ? "The model" : `The model's subagent ${agentId}`;
  return {
    question: isExitPlanMode
      ? `${who} wants to leave Plan mode and start executing. Approve?`
      : `${who} wants to run \`${toolName}\`: ${detail}. Approve?`,
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
  return isApprovedAt(answers, 0);
}

/** `isApproved` for the `index`-th question of a prompt that asks about
 * several calls at once (a deferred approval); same strictness. */
export function isApprovedAt(answers: ChoiceAnswer[], index: number): boolean {
  return answers[index]?.selected.includes(APPROVE_OPTION_ID) ?? false;
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

/** What the CLI is told when a session defers approvals: refuse now, so the
 * call is not left open for a human, and stop the turn. Plain English: the
 * model reads it as the tool result. */
export const DEFERRED_APPROVAL_MESSAGE = "awaiting user approval; end your turn";

export function buildDeferredDecision(): PermissionDecision {
  return { behavior: "deny", message: DEFERRED_APPROVAL_MESSAGE };
}

// Characters that mean something in a permission rule's argument (wildcards,
// grouping, the list separator) or that no rule can spell (line breaks). An
// argument containing one is never put in a rule, because the rule might then
// match more than the one call the human approved.
const RULE_SPECIAL = /[*?[\]{}(),\\\n\r]/;

// Shell syntax that makes a command more than one thing to check (redirects,
// pipes, lists, substitutions). Measured with CLI 2.1.303: an exact
// `Bash(<command>)` rule does not grant a command with an output redirect
// (the model is asked again for the very same command), so for these the only
// grant that works is the whole tool.
const SHELL_OPERATORS = /[<>|&;`$]/;

/**
 * The `--allowedTools` rules that let a turn repeat calls a human approved.
 * Measured against Claude Code 2.1.303: a path-specific rule only grants as
 * `Edit(//absolute/path)` (it covers Write too; `Write(/abs)` does not
 * grant), and `Write`/`Edit` with no argument grant every call of the tool.
 *
 * Narrow where the grammar is known to be safe: file edits by absolute path,
 * Bash by exact command text (verified for a plain command with spaces).
 * Anything else (MCP tools, WebFetch, a path or command holding rule syntax or
 * shell operators, notebooks) is granted for the whole tool, for
 * that one turn only, because there is no per-call rule to write for it;
 * the call may have been approved narrower than it ends up being allowed.
 * `ExitPlanMode` needs no rule (the session leaves plan mode instead).
 */
export function buildGrantRules(grants: readonly ToolGrant[]): string[] {
  const rules = new Set<string>();
  for (const { tool, input } of grants) {
    if (tool === "ExitPlanMode") continue;
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
      const filePath = record.file_path;
      const path = typeof filePath === "string" ? posix.normalize(filePath) : undefined;
      rules.add(path !== undefined && path.startsWith("/") && !RULE_SPECIAL.test(path) ? `Edit(/${path})` : tool);
    } else if (tool === "Bash") {
      const command = record.command;
      rules.add(typeof command === "string" && command.trim() !== "" && !RULE_SPECIAL.test(command) && !SHELL_OPERATORS.test(command) ? `Bash(${command})` : "Bash");
    } else {
      rules.add(tool);
    }
  }
  return [...rules];
}

/** Per-server `timeout` for the permission MCP server, which stays silent
 * until a human answers. Honored by CLI 2.1.303 (without it the CLI cuts the
 * pending call at ~60 s); see `buildMcpSpawnConfig`'s doc comment. */
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
 * `permissionToken`'s server (`anywh-permission`) waits on a real human (an
 * approve/deny decision) with no bytes sent back until that happens — from
 * the CLI's point of view that's indistinguishable from a hung connection.
 * Without a per-server `timeout` the CLI cuts such a pending call at ~60 s
 * (measured on CLI 2.1.303) and repeats the request. `timeout` here overrides
 * that per server (it also acts as a floor under the idle timeout).
 *
 * The override DOES work. Re-measured with CLI 2.1.303 by
 * `scripts/manual/test-long-approval.mjs`: a permission approval left pending
 * for 120 s is still answerable and the approved tool runs. The manual test
 * only covers 120 s, so waits much longer than that are unverified. The
 * `requestTimeout = 0` on this relay's own HTTP servers (server.ts) and
 * `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the child env (session.ts) are
 * kept as additional guards. If an approval is ever cut, `sendTurn` surfaces
 * it as a normal tool error (the turn doesn't hang, it just can't get the
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
  /** `--allowedTools` rules approved by a human for this turn
   * (`buildGrantRules`). */
  grantedRules?: readonly string[];
}): McpSpawnConfig | undefined {
  const { choiceToken, permissionToken, mcpBridgeBaseUrl, mcpPermissionBridgeBaseUrl, blockAskUserQuestion, grantedRules = [] } = params;
  if (!choiceToken && !permissionToken && !blockAskUserQuestion && grantedRules.length === 0) return undefined;

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
    allowedTools: [...(choiceToken ? [CHOICE_ALLOWED_TOOL] : []), ...grantedRules].join(",") || undefined,
    permissionPromptTool: permissionToken ? PERMISSION_PROMPT_TOOL : undefined,
    // Force the model onto our `present_choice` (or, in plan mode, the
    // `planChoiceMarker.ts` text convention) instead of the CLI's own
    // native `AskUserQuestion` — see `McpSpawnConfig.disallowedTools`'s doc
    // comment for why the native one silently fails here.
    disallowedTools: blockAskUserQuestion ? "AskUserQuestion" : undefined,
    extraSystemPrompt: choiceToken ? CHOICE_USAGE_HINT : undefined,
  };
}
