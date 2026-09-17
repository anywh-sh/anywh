// The agent runtime contract — the single place that describes "what an
// agent CLI is" without describing "how the relay runs one". Everything in
// this file is data (interfaces, unions, function *types*) or a pure
// function type; nothing here spawns a process, opens a socket, or reads a
// clock. `runtimes/registry.ts` enforces that shape at the object level
// (`assertCoherent`); `architecture.test.ts` enforces it at the import
// level (only `runtimes/**` may construct an `ExecPlan`).
//
// An earlier sketch of `AgentRuntimeDef` assumed `buildTurnArgs(ctx):
// string[]` and a flat `streamFormat` enum as invariants — both true for a
// CLI that spawns once per turn and prints to stdout, both false for
// Codex, which is a JSON-RPC 2.0 daemon that holds one process per
// *session* and pushes requests back at the relay mid-turn. The fix isn't
// a Codex-shaped field bolted on: `exec` becomes a
// discriminated union (`ExecPlan`) whose variants are the input to a
// shared engine in `runtimes/engines/` (not written yet — this file exists
// to prove the union's shape first, against real drafts of a second and
// third agent, before a single line of engine code depends on it).

// ---------------------------------------------------------------------------
// Identity, capabilities, continuity — the descriptive half of the def.
// Everything down to `ExecPlan` answers "what is this CLI", not "how do we
// talk to it"; the fronteira dado/código lives at `identity.env`, whose
// values are read into a child's environment by the engine, never computed
// here.

export interface RuntimeIdentity {
  /** Stable key. Never rendered — see `Capabilities`/`PermissionMode` for
   * the `labelKey`s the UI actually shows. */
  readonly id: string;
  readonly bin: string;
  readonly fallbackBins?: readonly string[];
  readonly env: {
    /** Env var names that must never reach a spawned child — the golden
     * rule (`docs/invariants.md`) as data instead of a hardcoded list.
     * Never empty: every runtime bills *some* credential if it leaks. */
    readonly strip: readonly string[];
    readonly set?: Readonly<Record<string, string>>;
  };
  readonly install?: { readonly url: string; readonly docsUrl?: string };
  /** `CLAUDE.md`, `AGENTS.md` — whichever file this CLI reads for
   * project-level instructions, so the UI can point a user at the right
   * one instead of assuming Claude's. */
  readonly projectInstructionsFile: string;
}

export type CapabilityLevel = "native" | "bridged" | "none";

/** Exhaustive on purpose: a `Record`, not `Partial`. An optional
 * `presentChoice?: boolean` rots by *omission* — a capability added later
 * silently reads as falsy on every existing def, with no compiler error to
 * catch it. A `Record` turns "teach the contract a new capability" into a
 * type error on every def until each one states where it stands. */
export type AgentCapability =
  | "presentChoice"
  | "approvalPrompt"
  | "rewindTurn"
  | "replayHistory"
  | "backgroundJobs"
  | "thinking"
  | "contextUsage";

export type Capabilities = Readonly<Record<AgentCapability, CapabilityLevel>>;

/** One entry per file in `bridges/` — a bridge is a per-agent workaround
 * validated against a real binary, not a shared contract every agent must
 * implement. An empty `bridges` array on a def is correct, not a gap: it
 * means this agent needs none of today's three. */
export type BridgeId = "mcp" | "permission" | "planMarker";

/** Merges the old contract's `contextOwner`/`resumeStyle` into one union —
 * the two only ever varied together. `relay-transcript` is the fallback
 * for a CLI with no resume of its own, declared here rather than left
 * implicit: invariant 1 in `runtimes/README.md` is "the relay never guards
 * a second turn's context on its own memory", and this is its one
 * sanctioned exception. */
export type Continuity =
  | { readonly kind: "cli-resume"; readonly resumeStyle: "specify" | "capture" }
  | { readonly kind: "relay-transcript" };

export interface ModelOption {
  readonly id: string;
  readonly labelKey: string;
}

/** Describes *where* to find the model list as data, not a function that
 * goes and fetches it — the fetch (and any process it requires) is the
 * engine's job. `parse` is a pure function: text in, options out. */
export type ModelSource =
  | { readonly kind: "cli-probe"; readonly args: readonly string[]; readonly parse: (stdout: string) => readonly ModelOption[] }
  | { readonly kind: "session-rpc" }
  | { readonly kind: "static"; readonly options: readonly ModelOption[] };

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly account?: string;
}

export type AuthSource =
  | { readonly kind: "cli-probe"; readonly args: readonly string[]; readonly parse: (stdout: string) => AuthStatus }
  | { readonly kind: "session-rpc" }
  | { readonly kind: "none" };

// ---------------------------------------------------------------------------
// Permissions — a function of platform, not a flat list. `TSettings` is
// opaque to everything except the engine that owns it: the Claude engine
// never needs to know Codex's `sandboxMode` × `askForApproval` pair exists,
// and vice versa.

/** Six values, not `NodeJS.Platform`'s eleven — the ones a self-hoster
 * could plausibly run the relay on. `aix`, `haiku`, `cygwin`, `netbsd`,
 * `android` are real Node targets and not realistic anywh hosts; dropping
 * them keeps `PermissionPolicy.modesFor` a function a def author can
 * actually reason about exhaustively. */
export type HostPlatform = "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";

export interface PermissionMode<TSettings> {
  readonly id: string;
  readonly labelKey: string;
  readonly settings: TSettings;
  /** Whether choosing this mode can leave a turn waiting on a human
   * decision. `assertCoherent` rejects `approvalPrompt: "none"` paired
   * with any mode where this is `true` — a CLI that can't ask can't offer
   * a mode that assumes it will. */
  readonly pausesForApproval: boolean;
}

/** A function instead of a flat array because coverage differs by
 * platform: Codex's `workspace-write` sandbox mode doesn't exist on
 * win32, so there it's simply absent from the list rather than present and
 * silently weaker. `defaultModeId` is a single global default — it doesn't
 * have to appear on every platform's list, only on at least one, which is
 * what makes the win32 gap representable at all. */
export interface PermissionPolicy<TSettings> {
  readonly defaultModeId: string;
  modesFor(platform: HostPlatform): readonly PermissionMode<TSettings>[];
}

// ---------------------------------------------------------------------------
// Failure classification — `classifyError(text)` from the old contract
// becomes `classifyFailure(failure)` because Codex's JSON-RPC errors carry
// a numeric `error.code`; matching on prose alone would make this an
// implementation, not a signature every def can share.

export type FailureClass = "session-invalid" | "auth" | "transient" | "usage-limit" | "not-installed";

export interface RuntimeFailure {
  readonly text: string;
  readonly code?: number;
}

// ---------------------------------------------------------------------------
// The turn/server boundary — the vocabulary `session/`'s eventual
// successor to today's `choiceMachine.ts` and a
// `JsonRpcDaemonPlan`'s `handleServerRequest` both speak, so native
// approval (Codex's `item/commandExecution/requestApproval`) and
// bridged approval (today's `permissionBridge.ts`) are indistinguishable
// to whatever drives a turn.

export interface ApprovalDecision {
  readonly id: string;
  readonly labelKey: string;
}

export interface ApprovalRequest {
  readonly id: string;
  /** Plain text, not a `labelKey` — this describes *this* command or
   * tool call, not a static piece of UI chrome. */
  readonly summary: string;
  /** Degrades honestly at the level of the button: a CLI with no concept
   * of "allow for the rest of the session" simply never lists that
   * decision, instead of the UI offering it and the engine faking the
   * result. */
  readonly availableDecisions: readonly ApprovalDecision[];
}

/** `"deferred"` is a first-class answer, not a failure: the anywh answers
 * a structured question as the *next* turn (`present_choice`'s existing
 * behavior, commit `a964d12`), so a runtime that can hold the request open
 * and one that can't share this same return type without either one
 * lying about what happened. */
export type UserInputAnswer = { readonly text: string } | { readonly choiceId: string };

export interface TurnHost {
  requestApproval(request: ApprovalRequest): Promise<string>;
  requestUserInput(prompt: string): Promise<UserInputAnswer | "deferred">;
}

// ---------------------------------------------------------------------------
// The wire — `StreamMapper` is a direct function reference, not an enum
// switched on inside a shared engine. An enum needs a `default` case for
// formats it doesn't know about; a function reference doesn't have a dead
// branch to leave unhandled, and a CLI fork with a tweaked format just
// passes a wrapped mapper instead of the relay growing a new enum member.
//
// `AgentEvent` used to be a placeholder here (`Readonly<Record<string,
// unknown>>`) — this file's job at the time was proving the `ExecPlan`
// union's shape, not the event vocabulary. `protocol/agent-event.ts` (Phase
// 7) is that real vocabulary now, so `StreamMapper` is defined against it
// directly instead of carrying its own stand-in.
import type { AgentEvent } from "../protocol/agent-event.js";
export type { AgentEvent };

export type StreamMapper = (raw: string, ctx: { readonly turnId: string }) => readonly AgentEvent[];

export interface TurnContext {
  readonly cwd: string;
  readonly prompt: string;
  readonly modelId?: string;
  readonly permissionModeId: string;
  /** Set when resuming — absent on a session's first turn. */
  readonly resumeSessionId?: string;
}

// ---------------------------------------------------------------------------
// exec — the axis the old contract didn't have. A spawn-per-turn CLI with
// a known stream shape is *pure data*: an argv builder plus a mapper,
// reusing one shared engine (the "27 CLIs, 4 parsers" case from
// open-design). A JSON-RPC daemon reuses a JSON-RPC engine instead, which
// ACP inherits close to verbatim (`framing` is the one thing that differs).
//
// The rule that tests this design matters more than the shape of the type
// itself: no file outside `runtimes/` may write `exec.kind` — enforced in
// `architecture.test.ts`. If `session/` ever needs an
// `if (transport === 'jsonrpc')`, the abstraction failed and Codex became
// an enxerto (a graft) instead of a def.

export interface JsonRpcRequestSpec {
  readonly method: string;
  readonly params: unknown;
}

export interface SpawnPerTurnPlan {
  readonly kind: "spawnPerTurn";
  readonly promptDelivery: "argv" | "stdin" | "stdin-jsonl";
  readonly buildArgs: (ctx: TurnContext) => readonly string[];
  readonly mapStdoutLine: StreamMapper;
  /** Both plans carry an explicit interrupt shape — invariant 3
   * (`runtimes/README.md`, "killing a turn never destroys the session")
   * had no home in the old contract because it only ever described one
   * exec shape. `expectsCleanExit` is what lets the engine tell "the CLI
   * is shutting down after `SIGINT`" apart from "the CLI died". */
  readonly interrupt: { readonly signal: NodeJS.Signals; readonly expectsCleanExit: boolean };
}

export interface JsonRpcDaemonPlan {
  readonly kind: "jsonRpcDaemon";
  /** `ndjson`: one JSON value per line (Codex). `lsp-headers`: `Content-Length`-framed,
   * like LSP (ACP) — the one axis that actually differs between the two
   * JSON-RPC agents seen so far. */
  readonly framing: "ndjson" | "lsp-headers";
  readonly thread: {
    readonly start: (ctx: TurnContext) => JsonRpcRequestSpec;
  };
  readonly turn: {
    readonly start: (ctx: TurnContext) => JsonRpcRequestSpec;
    /** e.g. Codex's `turn/interrupt` — a method name, not a signal; a
     * daemon has no child process for the engine to `kill()`. */
    readonly interruptMethod: string;
  };
  /** Optional: only defs whose `capabilities.rewindTurn`/`replayHistory`
   * declare more than `"none"` need these — `assertCoherent` enforces the
   * pairing. A spawn-per-turn CLI never needs them: rewinding there is a
   * relay-side transcript operation (`transcriptFork.ts`'s job today),
   * never a method call. */
  readonly rewindMethod?: string;
  readonly replayHistoryMethod?: string;
  readonly mapNotification: StreamMapper;
  /** Where native approval and native structured input arrive — Codex's
   * `item/commandExecution/requestApproval` and `item/tool/requestUserInput`
   * both land here and get answered through the same `TurnHost` the MCP
   * bridges answer. Returning `undefined` means "not mine": the engine
   * responds method-not-found instead of leaving the daemon's request
   * hanging forever. */
  readonly handleServerRequest: (method: string, params: unknown, host: TurnHost) => Promise<unknown> | undefined;
}

/** Escape hatch for a transport that's neither of the above (a wrapped
 * subprocess pool, a remote HTTP agent, ...) — declared now so `ExecPlan`
 * is a closed union from day one instead of growing a third case as an
 * afterthought the day it's actually needed. */
export interface CustomPlan {
  readonly kind: "custom";
  readonly note: string;
}

export type ExecPlan = SpawnPerTurnPlan | JsonRpcDaemonPlan | CustomPlan;

// ---------------------------------------------------------------------------

export interface AgentRuntimeDef<TPermissionSettings = unknown> {
  readonly identity: RuntimeIdentity;
  readonly capabilities: Capabilities;
  readonly continuity: Continuity;
  readonly models: ModelSource;
  readonly auth: AuthSource;
  readonly permissions: PermissionPolicy<TPermissionSettings>;
  readonly bridges: readonly BridgeId[];
  readonly exec: ExecPlan;
  readonly classifyFailure?: (failure: RuntimeFailure) => FailureClass;
}
