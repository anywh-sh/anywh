// The real `AgentRuntimeDef` for Codex — promoted from a shape-proving
// draft (this file's earlier form) once `thread.start`/`turn.start` had
// real params to build and a real notification mapper
// (`runtimes/streams/codexAppServer.ts`) to wire in. Still not driving an
// actual turn anywhere: no engine reads `exec.kind === "jsonRpcDaemon"` yet
// (that's `runtimes/transports/codexDaemon.ts` plus the `SharedSession`
// integration that picks a driver per session), and `server.ts`'s
// `SELECTABLE_AGENT_IDS` still lists only `"claude"`, so this def reaches
// nothing a user can pick from the UI. `runtimes/README.md` §5 has the
// three questions that decided `exec.kind` for this def.
//
// Every protocol detail below — `thread/start`, `turn/start`,
// `turn/interrupt`'s params, every notification
// `runtimes/streams/codexAppServer.ts` maps, and `handleServerRequest`'s
// params parsing — is checked against the real generated protocol bindings
// (`codex app-server generate-ts --experimental`, `codex-cli 0.154.0`), not
// guessed. The one gap still open: whether `item/tool/requestUserInput`
// actually fires under Codex's default settings, or needs an opt-in flag
// (`--enable default_mode_request_user_input` in an earlier build) — that
// needs checking against a real logged-in `codex app-server` session, and
// belongs in `runtimes/transports/codexDaemon.ts`'s spawn/handshake if so,
// not here.
import type { AgentRuntimeDef, ApprovalDecision, ApprovalRequest, JsonRpcRequestSpec, TurnContext, TurnHost, UserInputQuestion } from "../types.js";
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

/** Codex's own fixed decision vocabulary for both command and file-change
 * approvals — `CommandExecutionApprovalDecision`/`FileChangeApprovalDecision`
 * in the real generated bindings, both closed sets of string literals (plus,
 * for commands only, two object-payload variants carrying an execpolicy/
 * network-policy amendment — never offered here, see `toApprovalDecisions`
 * below for why). */
const CODEX_BASE_DECISIONS: readonly ApprovalDecision[] = [
  { id: "accept", labelKey: "codex.decision.accept" },
  { id: "acceptForSession", labelKey: "codex.decision.acceptForSession" },
  { id: "decline", labelKey: "codex.decision.decline" },
  { id: "cancel", labelKey: "codex.decision.cancel" },
];

type CommandDecisionWire =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: unknown }
  | { applyNetworkPolicyAmendment: unknown };

interface CommandActionWire {
  readonly type: "read" | "listFiles" | "search" | "unknown";
  readonly command: string;
}

interface CommandExecutionRequestApprovalParams {
  readonly kind?: "command" | "writeStdin" | null;
  readonly reason?: string | null;
  readonly command?: string | null;
  readonly commandActions?: readonly CommandActionWire[] | null;
  readonly availableDecisions?: readonly CommandDecisionWire[] | null;
}

/** `availableDecisions` is nullable (treat as the base set) and can carry
 * the two amendment-carrying object variants, which this contract has no
 * field for yet — filtered out rather than guessed at, the same
 * "a CLI with no concept of X simply never lists that decision" degradation
 * `runtimes/README.md` §4 already asks of `ApprovalDecision` itself. */
function toApprovalDecisions(wire: readonly CommandDecisionWire[] | null | undefined): readonly ApprovalDecision[] {
  if (!wire) return CODEX_BASE_DECISIONS;
  const byId = new Map(CODEX_BASE_DECISIONS.map((decision) => [decision.id, decision] as const));
  return wire
    .filter((decision): decision is "accept" | "acceptForSession" | "decline" | "cancel" => typeof decision === "string")
    .map((id) => byId.get(id))
    .filter((decision): decision is ApprovalDecision => decision !== undefined);
}

/** v1 folds `commandActions` into one line rather than giving them their
 * own wire shape — friendly per-action rendering (read/listFiles/search) is
 * later client polish, not part of getting a real answer back to Codex;
 * nothing is lost, just less nicely formatted, same fallback philosophy
 * `describeToolCall` (`defs/claude/mcpSpawnConfig.ts`) already uses for an
 * unrecognized Claude tool. */
function describeCommandActions(actions: readonly CommandActionWire[] | null | undefined): string | undefined {
  return actions && actions.length > 0 ? actions.map((action) => action.command).join("; ") : undefined;
}

function buildCommandApprovalRequest(params: CommandExecutionRequestApprovalParams): ApprovalRequest {
  const kind = params.kind ?? "command";
  const text = params.command ?? describeCommandActions(params.commandActions) ?? "(no command text)";
  const decisions = toApprovalDecisions(params.availableDecisions);
  return {
    id: crypto.randomUUID(),
    summary: params.reason ? `Codex wants to run: ${text} (${params.reason})` : `Codex wants to run: ${text}`,
    detail: { kind, text, reason: params.reason ?? undefined },
    availableDecisions: decisions,
    safeDecisionId: decisions.find((decision) => decision.id === "cancel")?.id ?? decisions.find((decision) => decision.id === "decline")?.id,
  };
}

interface FileChangeRequestApprovalParams {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
}

/** Unlike a command approval, a file-change one has no `availableDecisions`
 * field at all in the real protocol — its decision set is always exactly
 * the base four, no per-request variability. */
function buildFileChangeApprovalRequest(params: FileChangeRequestApprovalParams): ApprovalRequest {
  const text = params.grantRoot ?? "(unspecified path)";
  return {
    id: crypto.randomUUID(),
    summary: params.reason ? `Codex wants to change files under ${text} (${params.reason})` : `Codex wants to change files under ${text}`,
    detail: { kind: "fileChange", text, reason: params.reason ?? undefined },
    availableDecisions: CODEX_BASE_DECISIONS,
    safeDecisionId: "cancel",
  };
}

interface ToolRequestUserInputParams {
  readonly questions: readonly {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isSecret: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[] | null;
  }[];
}

function toUserInputQuestions(params: ToolRequestUserInputParams): readonly UserInputQuestion[] {
  return params.questions.map((question) => ({
    id: question.id,
    header: question.header || undefined,
    question: question.question,
    options: question.options ?? undefined,
    secret: question.isSecret,
  }));
}

// A daemon that pushes any of these at the relay mid-turn is exactly what
// made `exec` a union: none has an equivalent in a spawn-per-turn,
// stdout-only world. `item/permissions/requestApproval` (a different,
// session/trust-level approval, not item-level), `mcpServer/elicitation/request`
// (Codex acting as an MCP *host* for a third-party server the user
// configured) and `item/tool/call` (Codex asking the relay to execute a
// tool on its behalf) are real methods in the generated bindings but
// materially different features from item-level approval/user-input —
// deliberately left unhandled, falling through to `undefined` like any
// other unrecognized method.
function handleServerRequest(method: string, params: unknown, host: TurnHost): Promise<unknown> | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return host
      .requestApproval(buildCommandApprovalRequest(params as CommandExecutionRequestApprovalParams))
      .then((decision) => ({ decision }));
  }
  if (method === "item/fileChange/requestApproval") {
    return host
      .requestApproval(buildFileChangeApprovalRequest(params as FileChangeRequestApprovalParams))
      .then((decision) => ({ decision }));
  }
  if (method === "item/tool/requestUserInput") {
    return host.requestUserInput(toUserInputQuestions(params as ToolRequestUserInputParams)).then((answers) => ({
      // An empty map (rather than throwing) for the "deferred" case keeps a
      // defensive fallback instead of crashing the daemon connection on a
      // host that returns it anyway — `SharedSession.requestUserInput`
      // never actually does, since Codex's stdio JSON-RPC transport blocks
      // synchronously on this response and can't hold it open past the
      // current turn.
      answers: answers === "deferred" ? {} : Object.fromEntries(answers.map((answer) => [answer.questionId, { answers: answer.values }])),
    }));
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
