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
import { BILLED_CREDENTIAL_VARS } from "../../executables.js";
import { mapClaudeEvent } from "../../streams/claudeStreamJson.js";
import { parseClaudeAuthStatus } from "../../probes/authStatus.js";
import type { AgentRuntimeDef, FailureClass, RuntimeFailure, TurnContext } from "../../types.js";
import { buildTurnArgs, CLAUDE_AGENT_ENV_OVERRIDES, isSessionInvalidError, type ClaudeEvent } from "./session.js";
// Same reverse-direction dependency session.ts already declares (see its
// own comment on this import): PermissionMode is exactly the kind of field
// PermissionPolicy<S> takes over, but declaring this def's own settings
// shape independent of session/sessionStore.ts is bigger surgery than this
// phase's job (adding the def, not moving where PermissionMode lives) — left
// for when an engine actually needs `permissions.modesFor` at runtime.
// eslint-disable-next-line import-x/no-restricted-paths
import type { PermissionMode } from "../../../session/sessionStore.js";

function buildArgs(ctx: TurnContext): string[] {
  // Known gap, not hidden: TurnContext doesn't carry MCP config or the
  // choice-bridge's extraSystemPrompt (SharedSession's per-turn decision,
  // never a def concern) — so this never registers a bridge. A real engine
  // consuming this would need TurnContext to grow both before this could
  // replace ClaudeSession.sendTurn's own argv building.
  const args = buildTurnArgs(ctx.prompt, ctx.permissionModeId as PermissionMode, ctx.modelId);
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

const CLAUDE_PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export const claudeRuntimeDef: AgentRuntimeDef<PermissionMode> = {
  identity: {
    id: "claude",
    bin: "claude",
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
  exec: {
    kind: "spawnPerTurn",
    promptDelivery: "argv",
    buildArgs,
    mapStdoutLine,
    interrupt: { signal: "SIGINT", expectsCleanExit: true },
  },
  classifyFailure,
};
