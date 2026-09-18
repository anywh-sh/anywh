// The real `AgentRuntimeDef` for Codex — promoted from a shape-proving
// draft (this file's earlier form) once `thread.start`/`turn.start` had
// real params to build and a real notification mapper
// (`runtimes/streams/codexAppServer.ts`) to wire in. Driven by
// `CodexSessionDriver` (`runtimes/defs/codexDriver.ts`, via
// `createSessionDriver`) once a session's `agentId` resolves to this def
// (`SessionManager.createSession`/`setAgent`) — reachable from the UI's
// agent picker since `server.ts`'s `SELECTABLE_AGENT_IDS` lists `"codex"`
// alongside `"claude"`. `runtimes/README.md` §5 has the three questions
// that decided `exec.kind` for this def.
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
//
// `turn/start`'s `approvalPolicy`/`sandboxPolicy` (settingsFor below) were
// checked the same way, PLUS a live smoke test against a real, logged-in
// `codex app-server` (a scripted `initialize` -> `thread/start` -> two
// `turn/start`s, one command writing inside the turn's cwd, one writing to a
// sibling directory outside it) — reading the generated types alone would
// have shipped a bug here: this def used to send `askForApproval:
// "on-failure"` for `workspace-write`, and that value doesn't exist in the
// real wire `AskForApproval` union at all (confirmed two ways: the
// generated bindings, and `codex --help` documenting only `on-request`/
// `never` as public values today — `untrusted`/`on-failure` are legacy
// `config.toml` vocabulary being replaced by `granular`, a set of finer
// booleans). The smoke test confirmed `granular.sandbox_approval: true`
// reproduces exactly the behavior `on-failure` was trying to express: the
// in-cwd write completed with no approval request at all, the out-of-cwd
// one triggered a real `item/commandExecution/requestApproval` with
// `reason: "command failed; retry without sandbox?"`, and declining it left
// the file unwritten. `granular` only works with `experimentalApi: true` in
// `initialize`'s capabilities (see `runtimes/transports/codexDaemon.ts`) —
// without it every `turn/start` in `workspace-write` mode was rejected
// outright, confirmed live the same way.
import type { AgentRuntimeDef, ApprovalDecision, ApprovalRequest, JsonRpcRequestSpec, QuickPromptContext, TurnContext, TurnHost, UserInputQuestion } from "../types.js";
import { mapCodexNotification } from "../streams/codexAppServer.js";

/** The real wire shape of `TurnStartParams.approvalPolicy` — confirmed
 * against generated bindings (`v2/AskForApproval.ts`). The `granular` object
 * is the modern replacement for the legacy `untrusted`/`on-failure` config
 * values (see the module doc comment above); only `sandbox_approval` is ever
 * set to `true` here, the other four booleans are real, independent gates
 * this def doesn't offer a mode for yet (a per-tool-category approval UI is
 * out of scope — v1 is "does this session's mode ever pause", not "which of
 * five categories"). */
type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | { readonly granular: { readonly sandbox_approval: boolean; readonly rules: boolean; readonly skill_approval: boolean; readonly request_permissions: boolean; readonly mcp_elicitations: boolean } };

/** The real wire shape of `TurnStartParams.sandboxPolicy` — confirmed
 * against generated bindings (`v2/SandboxPolicy.ts`), a `type`-tagged union,
 * camelCase, unlike the config-file spelling (`read-only`, `danger-full-
 * access`) this def used to send. `externalSandbox` (a fourth real variant,
 * for a sandbox Codex doesn't own) is omitted: nothing here ever
 * constructs it. */
type CodexSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: boolean }
  | { readonly type: "workspaceWrite"; readonly writableRoots: readonly string[]; readonly networkAccess: boolean; readonly excludeTmpdirEnvVar: boolean; readonly excludeSlashTmp: boolean };

/** Codex's own two-axis permission model — opaque to everything except
 * whatever engine ends up owning it (`TSettings` in `runtimes/types.ts`).
 * Real Codex CLI concepts, not invented ones: `sandboxPolicy` controls what
 * a shell command can touch, `approvalPolicy` controls when the daemon
 * pauses to ask. */
export interface CodexPermissionSettings {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexSandboxPolicy;
}

/** Maps a mode id to the real `turn/start` wire params — the one place this
 * mapping lives, reused by both `permissions.modesFor` (structural, `cwd`
 * unknown that early and irrelevant there: nothing reads `.settings` off
 * that list today, `session/permissionModes.ts` only extracts `id`/
 * `pausesForApproval`) and `startTurn` (the real, per-turn `cwd`, actually
 * sent on the wire). `undefined` for an id this def doesn't recognize —
 * `startTurn` below sends no override rather than guess, which should be
 * unreachable in practice (`SharedSession` already validated the id against
 * this same def's `modesFor` before a turn ever starts) but costs nothing to
 * degrade safely if it somehow isn't. */
function settingsFor(id: string, cwd: string): CodexPermissionSettings | undefined {
  switch (id) {
    case "read-only":
      return { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "workspace-write":
      return {
        approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false } },
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    case "full-access":
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    default:
      return undefined;
  }
}

/** `ThreadStartParams` is far richer than this in the real protocol (model
 * overrides, sandbox/approval policy, a permissions profile id, ...) — every
 * field but `cwd` is optional, and none of the rest has a `TurnContext`
 * counterpart to source from yet, so this stays minimal rather than
 * guessing at defaults the real binary already applies on its own.
 * Deliberately NOT where `approvalPolicy`/`sandboxPolicy` are set even
 * though `ThreadStartParams` has room for them: a per-turn override
 * (`startTurn` below) is the only source of truth, so settings on the
 * thread itself never have a chance to drift from what the session's
 * dropdown actually shows. */
function startThread(ctx: TurnContext): JsonRpcRequestSpec {
  return { method: "thread/start", params: { cwd: ctx.cwd } };
}

/** `threadId` comes from the engine, not `ctx` — see `JsonRpcDaemonPlan.turn.start`'s
 * own doc comment on why. Real `TurnStartParams.input` is a content array,
 * never a plain string — `text_elements` is a UI-only concept (spans within
 * the text for rendering/persisting special elements) that a relay-composed
 * prompt never has any of. `approvalPolicy`/`sandboxPolicy` are the actual
 * application of `ctx.permissionModeId` (see the module doc comment and
 * `settingsFor` above) — omitted from `params` entirely for an unrecognized
 * id rather than sent as `undefined`, since the real binary's error message
 * for the two fields ("`permissions` cannot be combined with
 * `sandboxPolicy`"/"...`sandbox`") confirms the daemon distinguishes
 * "absent" from "present but empty". */
function startTurn(ctx: TurnContext, threadId: string): JsonRpcRequestSpec {
  const settings = settingsFor(ctx.permissionModeId, ctx.cwd);
  return {
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: ctx.prompt, text_elements: [] }],
      ...(settings ? { approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandboxPolicy } : {}),
    },
  };
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

/**
 * `codex exec`, Codex's own non-interactive one-shot mode — confirmed live
 * against a real logged-in `codex-cli 0.154.0` rather than guessed:
 * `--sandbox read-only` alone was enough to make the daemon pick
 * `approval: never` on its own (nothing a probe would run needs approval
 * anyway), and a title-generator-shaped prompt came back a clean short
 * answer with no tool calls despite Codex having no `--system-prompt`-
 * equivalent override. `systemPrompt`/`userPrompt` are folded into one argv
 * string instead (labeled "User text:", the same boundary Claude's separate
 * flag draws structurally) — an honest degrade, not a proven-safe one: text
 * crafted to look like part of the instruction has no structural wall
 * stopping it here the way Claude's flag provides one. No `-m`: unlike
 * Claude's `haiku` alias, `models: session-rpc` above means this relay has
 * no static "cheap model" name for Codex to reach for, so this uses
 * whichever model the account already defaults to rather than guessing one
 * that might not exist. `--ephemeral` skips persisting a session file for a
 * call nothing ever resumes; `--skip-git-repo-check` since a session's cwd
 * isn't guaranteed to be a git repo.
 */
function buildQuickPromptArgs(ctx: QuickPromptContext): string[] {
  return ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--json", `${ctx.systemPrompt}\n\nUser text:\n${ctx.userPrompt}`];
}

interface CodexExecItemCompleted {
  readonly type: "item.completed";
  readonly item: { readonly type: string; readonly text?: string };
}

/**
 * `codex exec --json`'s own JSONL event stream — a different wire format
 * from `runtimes/streams/codexAppServer.ts`'s JSON-RPC notifications (the
 * real turn's own protocol), so this curates its own minimal subset rather
 * than reusing that file's types. Confirmed live that `--json` keeps the
 * human-readable preamble/transcript entirely off stdout (it goes to
 * stderr instead) — parsing stdout as JSONL needs no screen-scraping.
 * Picks the LAST `item.completed` `agent_message`, mirroring
 * `codexAppServer.ts`'s `mapItemCompleted` picking a turn's final text the
 * same way. `undefined` for a line that isn't valid JSON or isn't this
 * shape — same "unrecognized, drop it" tolerance every other Codex mapper
 * in this codebase already has.
 */
function extractCodexQuickPromptReply(stdout: string): string | undefined {
  let reply: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const typed = event as Partial<CodexExecItemCompleted>;
    if (typed.type === "item.completed" && typed.item?.type === "agent_message" && typeof typed.item.text === "string") {
      reply = typed.item.text;
    }
  }
  return reply;
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
      // `cwd: "."` is a structural placeholder — see `settingsFor`'s own
      // comment for why this list's `.settings` never needs the real one.
      const modes = [
        { id: "read-only", labelKey: "codex.mode.readOnly", settings: settingsFor("read-only", ".")!, pausesForApproval: true },
        { id: "workspace-write", labelKey: "codex.mode.workspaceWrite", settings: settingsFor("workspace-write", ".")!, pausesForApproval: true },
        { id: "full-access", labelKey: "codex.mode.fullAccess", settings: settingsFor("full-access", ".")!, pausesForApproval: false },
      ];
      // workspace-write's sandbox has no win32 implementation — absent,
      // not present-and-silently-weaker. The other two modes are sandbox-less
      // (read-only doesn't need OS enforcement to refuse writes; full-access
      // has no sandbox to be missing) and survive on every platform.
      return platform === "win32" ? modes.filter((mode) => mode.id !== "workspace-write") : modes;
    },
  },
  bridges: [],
  quickPrompt: { kind: "cli", buildArgs: buildQuickPromptArgs, extractReply: extractCodexQuickPromptReply },
  exec: {
    kind: "jsonRpcDaemon",
    framing: "ndjson",
    thread: { start: startThread },
    turn: { start: startTurn, interrupt: (threadId, turnId) => ({ method: "turn/interrupt", params: { threadId, turnId } }) },
    mapNotification: mapCodexNotification,
    handleServerRequest,
  },
  // Measured with codex-cli 0.154.0 against the real `codex exec --json`
  // binary, same paired-diff method as Claude's own constants (see that
  // def's comment): an empty directory versus one holding only AGENTS.md,
  // against o200k_base's raw count. The multiplier came back exactly 1.000
  // with a fixed ~21-token residual across both English and pt-BR files —
  // because here the encoding isn't a proxy, it's OpenAI's own tokenizer
  // for the model this CLI actually runs, unlike Claude's cl100k_base fit,
  // which stays an approximation of a tokenizer this repo can't call
  // directly. No empty-directory surcharge was measurable on this CLI
  // (baseline stayed flat, ±4 tokens of pure noise, whether the directory
  // held nothing or one unrelated file) — `0` here is that real finding,
  // not an unmeasured placeholder.
  contextAccounting: {
    encoding: "o200k_base",
    rules: { multiplier: 1.0, perFile: 21 },
    emptyDirectoryInflation: 0,
  },
};
