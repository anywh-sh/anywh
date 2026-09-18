// The real `AgentRuntimeDef` for Claude Code — see `runtimes/README.md` §7
// for why this is the contract's worst-served member, not its reference
// implementation: `approvalPrompt`/`presentChoice` are bridged workarounds,
// `classifyFailure` has no numeric code to work with (regex against
// stderr prose, same fragility `isSessionInvalidError` already has), and
// `ApprovalRequest`/`UserInputAnswer`'s `reason` is always `undefined` —
// the CLI has no channel to report one.
//
// No engine (`runtimes/engines/`) reads this yet — `ClaudeSession`
// (`session.ts`) is still what actually spawns a turn. This def exists so
// `runtimes/detection.ts` and a future `AuthSource`-driven UI have
// something real to probe, ahead of an engine depending on it.
import { AGENT_BIN, BILLED_CREDENTIAL_VARS } from "../../executables.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";
import { parseClaudeAuthStatus } from "../../probes/authStatus.js";
import type { AgentRuntimeDef, FailureClass, QuickPromptContext, RuntimeFailure, TurnContext } from "../../types.js";
import { buildTurnArgs, CLAUDE_AGENT_ENV_OVERRIDES, isSessionInvalidError, toClaudeMode, type ClaudeEvent, type ClaudePermissionMode } from "./session.js";

function buildArgs(ctx: TurnContext): string[] {
  // Known gap, not hidden: TurnContext doesn't carry MCP config or the
  // choice-bridge's extraSystemPrompt (SharedSession's per-turn decision,
  // never a def concern) — so this never registers a bridge. A real engine
  // consuming this would need TurnContext to grow both before this could
  // replace ClaudeSession.sendTurn's own argv building.
  const args = buildTurnArgs(ctx.prompt, toClaudeMode(ctx.permissionModeId), ctx.modelId);
  if (ctx.resumeSessionId) args.push("--resume", ctx.resumeSessionId);
  return args;
}

function mapStdoutLine(raw: string) {
  let event: ClaudeEvent;
  try {
    event = JSON.parse(raw) as ClaudeEvent;
  } catch {
    return [];
  }
  return mapClaudeEvent(event);
}

/** `--system-prompt` (not `--append-system-prompt`) because Claude Code's
 * default system prompt (code-assistant persona) competes with a probe's
 * instruction and the model tries to "help" instead of just answering it —
 * tested manually, only the full override works reliably. `haiku`: cheap
 * and fast is the whole point of a probe, and Claude has a stable alias for
 * that tier (unlike Codex, whose `models: session-rpc` means this relay has
 * no static "cheap model" name to reach for — see `codex.ts`'s own
 * `quickPrompt`). No tools, no MCP, no persistence: a probe never needs any
 * of the three. */
function buildQuickPromptArgs(ctx: QuickPromptContext): string[] {
  return [
    "-p",
    ctx.userPrompt,
    "--system-prompt",
    ctx.systemPrompt,
    "--model",
    "haiku",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--tools",
    "",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
  ];
}

function classifyFailure(failure: RuntimeFailure): FailureClass {
  if (isSessionInvalidError(failure.text)) return "session-invalid";
  // Exact wording captured from a real 5-hour/weekly limit hit — see
  // session.test.ts's isSessionInvalidError coverage for the same string.
  if (/usage limit reached/i.test(failure.text)) return "usage-limit";
  if (/ENOENT|command not found/i.test(failure.text)) return "not-installed";
  // Everything else (an overloaded API, a network hiccup, ...) is the safe
  // default: none of it says the session itself is invalid.
  return "transient";
}

const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export const claudeRuntimeDef: AgentRuntimeDef<ClaudePermissionMode> = {
  identity: {
    id: "claude",
    // Already resolved (bare "claude", an absolute WELL_KNOWN_BIN_DIRS
    // path, or an operator's AGENT_BIN/CLAUDE_BIN override — see
    // executables.ts) rather than the literal "claude": this is the exact
    // binary every real turn spawns, and runtimes/detection.ts's own probe
    // needs to agree with that, not re-derive a bare name that ignores the
    // override (and, in a test process, the fake-claude.mjs fixture).
    bin: AGENT_BIN,
    env: { strip: BILLED_CREDENTIAL_VARS, set: CLAUDE_AGENT_ENV_OVERRIDES },
    projectInstructionsFile: "CLAUDE.md",
  },
  capabilities: {
    // Both bridged, never native: `--permission-prompt-tool` and the
    // `present_choice` MCP tool are workarounds (permissionBridge.ts,
    // mcpBridge.ts), not a first-class protocol feature the CLI offers.
    presentChoice: "bridged",
    approvalPrompt: "bridged",
    // Both relay-side operations on the on-disk transcript
    // (transcriptFork.ts, transcriptReader.ts) — spawnPerTurn has no
    // rewind/replay method to require, see assertCoherent.
    rewindTurn: "native",
    replayHistory: "native",
    backgroundJobs: "native",
    thinking: "native",
    contextUsage: "native",
  },
  // The relay captures the session_id the CLI hands back; it never assigns
  // one ahead of time.
  continuity: { kind: "cli-resume", resumeStyle: "capture" },
  // Deliberately not "real" yet: the actual catalog is dynamic (the CLI's
  // own `/model` probe, runtimes/probes/defaultModel.ts) and each option
  // doesn't have a static labelKey — the client resolves aliases at
  // runtime instead. Forcing that into ModelOption.labelKey here would be a
  // false correspondence; this stays a placeholder until that tension is
  // resolved, same spirit as the codex/acp drafts proving shape, not truth.
  models: { kind: "static", options: [] },
  auth: {
    kind: "cli-probe",
    args: ["auth", "status", "--json"],
    // Drops `subscriptionType` on purpose: `routes/profiles.ts` still calls
    // `runClaudeAuthStatus` directly for that (`AddProfileDialog.tsx`
    // renders it), and this generic `AuthSource.parse` is a different,
    // poorer caller — swapping `routes/profiles.ts` over to this would
    // silently lose that field from the UI.
    parse: (stdout) => {
      const status = parseClaudeAuthStatus(stdout);
      return { loggedIn: status.loggedIn, account: status.email };
    },
  },
  permissions: {
    defaultModeId: "bypassPermissions",
    // Same four modes, same pausesForApproval split, on every platform —
    // unlike Codex there's no OS-specific gap here to represent.
    modesFor: () =>
      CLAUDE_PERMISSION_MODES.map((id) => ({
        id,
        labelKey: `claude.mode.${id}`,
        settings: id,
        pausesForApproval: id !== "bypassPermissions",
      })),
  },
  bridges: ["mcp", "permission", "planMarker"],
  quickPrompt: {
    kind: "cli",
    buildArgs: buildQuickPromptArgs,
    // `--output-format text` already prints nothing but the reply — no
    // JSONL to pick a final message out of, unlike Codex's `exec --json`.
    extractReply: (stdout) => stdout.trim() || undefined,
  },
  exec: {
    kind: "spawnPerTurn",
    promptDelivery: "argv",
    buildArgs,
    mapStdoutLine,
    interrupt: { signal: "SIGINT", expectsCleanExit: true },
  },
  classifyFailure,
};
