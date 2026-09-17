// The real `AgentRuntimeDef` for Codex — promoted from a shape-proving
// draft (this file's earlier form) once `thread.start`/`turn.start` had
// real params to build and a real notification mapper
// (`runtimes/streams/codexAppServer.ts`) to wire in. Still not driving an
// actual turn anywhere: no engine reads `exec.kind === "jsonRpcDaemon"` yet
// (that's `runtimes/transports/codexDaemon.ts` plus the `SharedSession`
// integration that picks a driver per session — a later phase), and
// `server.ts`'s `SELECTABLE_AGENT_IDS` still lists only `"claude"`, so this
// def reaches nothing a user can pick from the UI. `runtimes/README.md` §5
// has the three questions that decided `exec.kind` for this def.
//
// Protocol details below were checked two ways, and this comment says which
// is which: the ones checked only against a real `codex-cli 0.154.0`
// session logged in via ChatGPT (not documentation) are
// `item/commandExecution/requestApproval` and `item/tool/requestUserInput`
// as method names — load-bearing, but their *params* below
// (`handleServerRequest`) are still illustrative placeholders, not the real
// `CommandExecutionRequestApprovalParams`/`ToolRequestUserInputParams`
// shapes; wiring those up for real is Phase 11's job (human-in-the-loop),
// not this one. Everything else — `thread/start`, `turn/start`,
// `turn/interrupt`'s params, and every notification
// `runtimes/streams/codexAppServer.ts` maps — is checked against the real
// generated protocol bindings (`codex app-server generate-ts
// --experimental`, same binary), which is what makes this def's
// turn-driving half (not the approval half) trustworthy today.
import type { AgentRuntimeDef, JsonRpcRequestSpec, TurnContext, TurnHost } from "../types.js";
import { mapCodexNotification } from "../streams/codexAppServer.js";

/** Codex's own two-axis permission model — opaque to everything except
 * whatever engine ends up owning it. Real Codex CLI concepts, not
 * invented ones: `sandboxMode` controls what a shell command can touch,
 * `askForApproval` controls when the daemon pauses to ask. */
export interface CodexPermissionSettings {
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly askForApproval: "untrusted" | "on-failure" | "on-request" | "never";
}

/** `ThreadStartParams` is far richer than this in the real protocol (model
 * overrides, sandbox/approval policy, a permissions profile id, ...) — every
 * field but `cwd` is optional, and none of the rest has a `TurnContext`
 * counterpart to source from yet, so this stays minimal rather than
 * guessing at defaults the real binary already applies on its own. */
function startThread(ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "thread/start", params: { cwd: ctx.cwd } };
}

/** `threadId` comes from the engine, not `ctx` — see `JsonRpcDaemonPlan.turn.start`'s
 * own doc comment on why. Real `TurnStartParams.input` is a content array,
 * never a plain string — `text_elements` is a UI-only concept (spans within
 * the text for rendering/persisting special elements) that a relay-composed
 * prompt never has any of. */
function startTurn(ctx: TurnContext, threadId: string): JsonRpcRequestSpec {
  return { method: "turn/start", params: { threadId, input: [{ type: "text", text: ctx.prompt, text_elements: [] }] } };
}

// Real Codex methods; not placeholders — see this file's header comment for
// which parts of this function still are. A daemon that pushes both of
// these at the relay mid-turn is exactly what made `exec` a union: neither
// has an equivalent in a spawn-per-turn, stdout-only world.
function handleServerRequest(method: string, params: unknown, host: TurnHost): Promise<unknown> | undefined {
  if (method === "item/commandExecution/requestApproval") {
    const { summary, decisions } = params as { summary: string; decisions: readonly { id: string; labelKey: string }[] };
    return host.requestApproval({ id: crypto.randomUUID(), summary, availableDecisions: decisions });
  }
  if (method === "item/tool/requestUserInput") {
    const { prompt } = params as { prompt: string };
    return host.requestUserInput(prompt);
  }
  return undefined;
}

export const codexRuntimeDef: AgentRuntimeDef<CodexPermissionSettings> = {
  identity: {
    id: "codex",
    bin: "codex",
    env: { strip: ["OPENAI_API_KEY"] },
    projectInstructionsFile: "AGENTS.md",
  },
  capabilities: {
    // Both native: item/tool/requestUserInput and item/commandExecution/requestApproval
    // are structured server->client requests, not a text-marker heuristic
    // the way Claude's plan mode is.
    presentChoice: "native",
    approvalPrompt: "native",
    rewindTurn: "none",
    replayHistory: "none",
    // Unverified against the real binary yet — conservative "none" rather
    // than a claim this def can't back up.
    backgroundJobs: "none",
    thinking: "native",
    contextUsage: "native",
  },
  // Codex keeps its own conversation state daemon-side; the relay
  // resumes by referencing a thread id it captured, never by replaying.
  continuity: { kind: "cli-resume", resumeStyle: "capture" },
  models: { kind: "session-rpc" },
  auth: { kind: "session-rpc" },
  permissions: {
    defaultModeId: "workspace-write",
    modesFor: (platform) => {
      const modes = [
        { id: "read-only", labelKey: "codex.mode.readOnly", settings: { sandboxMode: "read-only", askForApproval: "on-request" } as CodexPermissionSettings, pausesForApproval: true },
        { id: "workspace-write", labelKey: "codex.mode.workspaceWrite", settings: { sandboxMode: "workspace-write", askForApproval: "on-failure" } as CodexPermissionSettings, pausesForApproval: true },
        { id: "full-access", labelKey: "codex.mode.fullAccess", settings: { sandboxMode: "danger-full-access", askForApproval: "never" } as CodexPermissionSettings, pausesForApproval: false },
      ];
      // workspace-write's sandbox has no win32 implementation — absent,
      // not present-and-silently-weaker. The other two modes are sandbox-less
      // (read-only doesn't need OS enforcement to refuse writes; full-access
      // has no sandbox to be missing) and survive on every platform.
      return platform === "win32" ? modes.filter((mode) => mode.id !== "workspace-write") : modes;
    },
  },
  bridges: [],
  exec: {
    kind: "jsonRpcDaemon",
    framing: "ndjson",
    thread: { start: startThread },
    turn: { start: startTurn, interrupt: (threadId, turnId) => ({ method: "turn/interrupt", params: { threadId, turnId } }) },
    mapNotification: mapCodexNotification,
    handleServerRequest,
  },
};
