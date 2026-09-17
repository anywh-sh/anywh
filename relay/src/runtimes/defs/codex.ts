// A design-validation DRAFT, not a runtime def — it is not exported from
// `registry.ts`, and no engine is written against it yet. `server.ts` does
// import it, to pass alongside `claudeRuntimeDef` into
// `runtimes/detection.ts`'s probe (whether the `codex` binary is present and
// what version it reports), but that's a version check, not execution:
// nothing here drives an actual turn, and the result never reaches a
// selectable-agent list (see server.ts's `SELECTABLE_AGENT_IDS`). Its main
// job is still proving that `../types.ts` actually accommodates a JSON-RPC
// daemon before any engine code is written against the contract; see
// `runtimes/README.md` §5 for the three questions that decide `exec.kind`.
// Codex is the agent that forced `exec` to become a union in the first
// place — it's a daemon with one process per session, not a CLI that spawns
// once per turn.
//
// Protocol details below (method names, the sandbox/approval settings
// pair) were checked against a real `codex-cli 0.154.0` session logged in
// via ChatGPT, not against documentation — the ones quoted verbatim
// (`item/commandExecution/requestApproval`, `item/tool/requestUserInput`,
// `turn/interrupt`) are load-bearing. `turn/interrupt`'s params
// (`{ threadId, turnId }`) are additionally confirmed against the real
// generated protocol bindings (`codex app-server generate-ts`, same
// binary) rather than just the logged session. `thread/start` and
// `turn/start`'s *params* are still illustrative placeholders, though —
// the generated bindings show them as `ThreadStartParams`/`TurnStartParams`,
// far richer than `{ prompt, cwd }` (real turn input is a content array,
// not a plain string, and carries dozens of optional overrides) — to be
// replaced by a real mapping when Codex support is implemented (a later
// phase — this draft only needs *a* method name to prove the shape typechecks).
import type { AgentRuntimeDef, JsonRpcRequestSpec, TurnContext, TurnHost } from "../types.js";

/** Codex's own two-axis permission model — opaque to everything except
 * whatever engine ends up owning it. Real Codex CLI concepts, not
 * invented ones: `sandboxMode` controls what a shell command can touch,
 * `askForApproval` controls when the daemon pauses to ask. */
export interface CodexPermissionSettings {
  readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  readonly askForApproval: "untrusted" | "on-failure" | "on-request" | "never";
}

function startThread(_ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "thread/start", params: {} };
}

function startTurn(ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "turn/start", params: { prompt: ctx.prompt, cwd: ctx.cwd } };
}

// Real Codex methods; not placeholders. A daemon that pushes both of these
// at the relay mid-turn is exactly what made `exec` a union: neither has
// an equivalent in a spawn-per-turn, stdout-only world.
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

export const codexRuntimeDraft: AgentRuntimeDef<CodexPermissionSettings> = {
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
    // than a claim this draft can't back up.
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
    mapNotification: () => [],
    handleServerRequest,
  },
};
