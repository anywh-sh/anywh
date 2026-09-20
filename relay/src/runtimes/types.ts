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
  /** Who the CLI says is logged in — Claude reports the account's email.
   * Absent when the CLI names no one: `codex login status` reports only
   * *how* the session authenticates, never whose it is. */
  readonly account?: string;
  /** What the CLI says that login is worth, as free text it chose — Claude's
   * `subscriptionType` ("pro"), Codex's login method ("ChatGPT"). Rendered
   * beside the account, never branched on. */
  readonly plan?: string;
}

/** Everything a CLI emitted answering an auth probe. A union of streams
 * rather than plain stdout because the two CLIs measured disagree on all
 * three: Claude prints JSON to stdout and exits 0 either way, Codex prints
 * a sentence to *stderr* and carries the answer in the exit code. A `parse`
 * that only sees stdout can express the first and not the second. */
export interface AuthProbeOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** `null` when the process was killed by a signal rather than exiting. */
  readonly exitCode: number | null;
}

export type AuthSource =
  | { readonly kind: "cli-probe"; readonly args: readonly string[]; readonly parse: (output: AuthProbeOutput) => AuthStatus }
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
  /** Structured parts, mirroring `ChoiceQuestion.approval`'s Claude-shaped
   * `{tool, detail}` — present so a client composes the localized sentence
   * instead of reading `summary` (English, fallback-only) verbatim. Absent
   * for a def with no structured breakdown to offer. */
  readonly detail?: {
    readonly kind: string;
    readonly text: string;
    readonly reason?: string;
  };
  /** Degrades honestly at the level of the button: a CLI with no concept
   * of "allow for the rest of the session" simply never lists that
   * decision, instead of the UI offering it and the engine faking the
   * result. */
  readonly availableDecisions: readonly ApprovalDecision[];
  /** The id a forced resolve (turn ends with no human answer) should treat
   * as "the safe choice" — declared by the def itself, since only it knows
   * which of `availableDecisions` actually means "no" for its own
   * vocabulary. Absent means the def has no known safe id; the caller falls
   * back to its own last resort. */
  readonly safeDecisionId?: string;
}

/** One of a native `requestUserInput` call's questions, translated from the
 * engine's own protocol. `options` absent or empty means no structured
 * choices were offered — the honest translation of a CLI that asks for free
 * text, not a gap in this contract. */
export interface UserInputQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  /** The UI should mask the answer — an engine-reported signal (Codex's
   * `isSecret`), not a heuristic guessed from the question text. */
  readonly secret?: boolean;
}

export interface UserInputAnswer {
  readonly questionId: string;
  readonly values: readonly string[];
}

export interface TurnHost {
  requestApproval(request: ApprovalRequest): Promise<string>;
  /** `"deferred"` is a first-class answer, not a failure: the anywh answers
   * a structured question as the *next* turn (`present_choice`'s existing
   * behavior, commit `a964d12`), so a runtime that can hold the request open
   * and one that can't share this same return type without either one
   * lying about what happened. A driver whose transport blocks synchronously
   * on this response (Codex's stdio JSON-RPC daemon) never actually returns
   * it. */
  requestUserInput(questions: readonly UserInputQuestion[]): Promise<readonly UserInputAnswer[] | "deferred">;
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

/** `JsonRpcDaemonPlan.mapNotification`'s shape, distinct from `StreamMapper`
 * — found while writing the first real implementation
 * (`runtimes/streams/codexAppServer.ts`) rather than assumed up front, which
 * is exactly what this file's header comment expected to happen before an
 * engine actually depended on the union. A daemon's transport
 * (`runtimes/transports/jsonRpcStdio.ts`) already parses the JSON-RPC
 * envelope before a notification ever reaches a def — handing a def the raw
 * line back would mean re-parsing an envelope the engine already decoded,
 * for no benefit a spawn-per-turn CLI's raw stdout line (which has no
 * envelope to unwrap) doesn't share. */
export type NotificationMapper = (method: string, params: unknown, ctx: { readonly turnId: string }) => readonly AgentEvent[];

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
    /** `threadId` is whatever the engine captured off `thread.start`'s own
     * response — a second parameter rather than a `TurnContext` field
     * because it's daemon-session state, not per-turn input. Confirmed
     * against Codex's real generated bindings that `turn/start` requires it
     * (`TurnStartParams.threadId`); found the same way the `interrupt`
     * fix below was. */
    readonly start: (ctx: TurnContext, threadId: string) => JsonRpcRequestSpec;
    /** Builds the interrupt request from the ids the engine captured off
     * `thread.start`/`turn.start`'s own responses — a bare method name (the
     * shape this replaced) can't express it: confirmed against Codex's real
     * generated protocol bindings (`codex app-server generate-ts`,
     * `codex-cli 0.154.0`) that `turn/interrupt` takes `{ threadId, turnId }`
     * as params, not just a method with none. A daemon has no child process
     * for the engine to `kill()`, so a request is the only way to stop one.
     * A def whose protocol has no per-turn id of its own (ACP's
     * `session/cancel` only takes a session id) simply declares an
     * `interrupt` that doesn't list the second parameter — TypeScript
     * allows a narrower function where this type is expected. */
    readonly interrupt: (threadId: string, turnId: string) => JsonRpcRequestSpec;
  };
  /** Optional: only defs whose `capabilities.rewindTurn`/`replayHistory`
   * declare more than `"none"` need these — `assertCoherent` enforces the
   * pairing. A spawn-per-turn CLI never needs them: rewinding there is a
   * relay-side transcript operation (`transcriptFork.ts`'s job today),
   * never a method call. */
  readonly rewindMethod?: string;
  readonly replayHistoryMethod?: string;
  readonly mapNotification: NotificationMapper;
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
// Context accounting — how much of the estimated (non-"Conversation") slice
// of a fresh session's baseline this def can actually name, versus leave in
// an honest residual. Not an `AgentCapability`: it doesn't change what the UI
// offers (that's already `contextUsage`), only how a breakdown a client
// already asked for gets computed — and unlike a capability, it's not a
// three-value enum, it's the calibrated constants themselves. `undefined` on
// a def (not every field on this interface) means "this agent can report a
// total, but not break it down" — a real, honest answer for an agent whose
// CLI never reports enough about its own setup cost, not a gap to fill in
// later. The estimator itself (reads disk, calls a tokenizer) intentionally
// isn't a method here: a field that needs an effect to answer belongs to the
// feature that owns that effect (`context/breakdown.ts`), not to a def that
// is supposed to stay inert data.
//
// Every constant here was measured against a real CLI, not guessed:
// diffing a session's own baseline between an empty directory and one
// containing only the rule file isolates that file's real cost, in that
// CLI's own tokenizer — a ground truth, not an estimate to calibrate
// against. `multiplier`/`perFile` fit that ground truth against a public
// BPE tokenizer's raw count (the closest proxy this repo can run without
// asking the vendor's own tokenizer, which neither CLI exposes), because
// this repo has to guess in production without ever being able to call the
// vendor's real one either.
export interface ContextRuleAccounting {
  /** Regression coefficient against the chosen `encoding`'s raw token count
   * — CLIs consistently under-report relative to a public BPE tokenizer
   * (never the reverse), by a factor specific to each CLI's own real
   * tokenizer and to how it wraps an injected file. */
  readonly multiplier: number;
  /** Fixed per-file overhead (the wrapper a CLI puts around an injected
   * file — its path, a delimiter) — visible only as a nonzero intercept
   * once a small enough file makes the multiplier's error disappear into
   * rounding. */
  readonly perFile: number;
}

/** Calibration for a CLI that reads a skill's description into its prompt —
 * absent `skills` on `ContextAccounting` entirely (not this shape with all
 * zeros) means the opposite: a CLI that lists skill names only, at a cost
 * small enough not to deserve its own line (Claude's real, measured case:
 * ~2.3 tokens/skill from the name alone, invisible against a 200k window). */
export interface ContextSkillAccounting {
  /** This CLI truncates the description before it ever reaches the prompt
   * — a longer one costs exactly as much as one truncated to this length,
   * not proportionally more. */
  readonly descriptionMaxTokens: number;
  readonly perEntry: number;
  readonly header: number;
  /** Relative paths (joined against both the session's `cwd` and the
   * agent's home directory) this CLI scans for a skill's own subfolder
   * (`<dir>/<name>/SKILL.md`) — plural because Codex accepts skills from
   * either `.codex/skills` or `.agents/skills`. */
  readonly dirs: readonly string[];
}

/** Calibration for a CLI with a subagent concept — absent on
 * `ContextAccounting` means this CLI has no such concept at all (Codex's
 * real, measured case), not "not measured yet". */
export interface ContextSubagentAccounting {
  readonly multiplier: number;
  readonly perEntry: number;
  readonly header: number;
  /** Relative paths (joined against both `cwd` and home) scanned for a flat
   * `<dir>/<name>.md` per subagent — Claude's real convention. */
  readonly dirs: readonly string[];
}

export interface ContextAccounting {
  /** Which public BPE encoding the `multiplier`/`perFile` below were fit
   * against — the newest encoding is not always the best proxy: pick
   * whichever one this CLI's own real tokenizer agrees with most across
   * languages, not whichever corresponds to the model generation in use. */
  readonly encoding: "cl100k_base" | "o200k_base";
  /** Calibration for `identity.projectInstructionsFile`. */
  readonly rules: ContextRuleAccounting;
  /** Extra baseline tokens a brand-new, otherwise-empty working directory
   * costs versus one with at least one unrelated file in it — some CLIs
   * inject a bigger prompt block when they find nothing to describe, and
   * that cost has nothing to do with any category above; `0` is a real,
   * measured "no such effect" for a CLI that doesn't do this, not a
   * placeholder for "not measured yet". */
  readonly emptyDirectoryInflation: number;
  readonly skills?: ContextSkillAccounting;
  readonly subagents?: ContextSubagentAccounting;
}

// ---------------------------------------------------------------------------
// Portability — what has to be true for this runtime's setup to be
// reproduced somewhere else: a fresh machine, a second profile on this one,
// a remote instance. Mandatory, not optional, for the same reason
// `Capabilities` is a `Record` and not a `Partial`: a runtime that can't
// answer this is a runtime the UI must not offer "bring my configuration"
// for, and an omitted field would read as "nothing to bring" on every def
// that predates it, with no compiler error to catch it.
//
// The shape is a manifest, never an archive. Copy what the user authored,
// declare what can be reinstalled, re-authenticate what is a secret — a
// runtime's config home also holds machine identity, absolute local paths
// and caches (measured: one CLI's is 100 KB across 82 keys, 25 of them
// local project paths), so "copy the home directory" is not a design, it's
// a data leak with extra steps.

/** Where a runtime's MCP server list is written, and whether that file is
 * the user's alone.
 *
 * `shared` is not an edge case — it is what both CLIs measured actually do:
 * the same file that holds the server list also holds model preferences,
 * per-project trust and machine identity. A `shared` file is merged key by
 * key, never copied over, and `portableKeys` is the allowlist of what may
 * cross. `dedicated` exists for a CLI whose declaration file is nothing
 * but declarations, which is a file that can simply be written. */
export type McpDeclaration =
  | { readonly kind: "dedicated"; readonly path: string; readonly format: McpDeclarationFormat }
  | { readonly kind: "shared"; readonly path: string; readonly format: McpDeclarationFormat; readonly portableKeys: readonly string[] };

/** Declared rather than inferred from the file extension: reading a key out
 * of this file and writing it back into someone else's is the one operation
 * that can corrupt a user's configuration, and "it ends in .toml" is a guess
 * dressed as a fact. Two formats because those are the two the measured CLIs
 * use; a third CLI adds a third here and the compiler finds every place that
 * has to learn it. */
export type McpDeclarationFormat = "json" | "toml";

/** How this CLI's MCP OAuth flow gets the authorization code back, which
 * decides whether a headless machine can complete a login at all.
 *
 * `paste-code` is the one that needs nothing from us: the CLI prints the
 * URL and takes the redirect back as text. The two port variants both
 * imply a browser reaching a loopback listener; `configurable-port` is the
 * milder one only because we write the config file the port lives in. */
export type McpCallback =
  | { readonly kind: "paste-code" }
  | { readonly kind: "ephemeral-port" }
  | {
      readonly kind: "configurable-port";
      /** Key path, inside the declaration file, that pins the port for one
       * server — a path rather than a number because the file is per
       * server (`mcp_servers.<name>.oauth.callback_port`), and pure data
       * because writing it is the engine's job, not this file's. */
      readonly portKeyPath: (serverName: string) => readonly string[];
    };

/** How the relay learns that a declared MCP server needs the user to log
 * in again — the difference between a UI that can warn beforehand and one
 * that can only react after a turn already failed. */
export type McpNeedsAuthSignal =
  | {
      readonly kind: "file";
      /** Relative to the runtime's config home, like every path here. */
      readonly path: string;
      /** Server names that file says need auth, parsed out of its raw
       * text. Pure, and tolerant: a file that isn't there yet, or is
       * malformed, means "nothing needs auth", never a crash. */
      readonly parse: (text: string) => readonly string[];
    }
  | { readonly kind: "in-band" };

export type McpContract =
  | { readonly kind: "none" }
  | {
      readonly kind: "supported";
      readonly declaration: McpDeclaration;
      /** Argv for this CLI's own login subcommand, per server. A pure
       * function returning args — nothing here runs it. */
      readonly loginArgs: (serverName: string) => readonly string[];
      /** `"pty"` when the CLI refuses to authenticate without a terminal
       * ("stdin isn't a terminal"), `"child"` when an ordinary process
       * suffices. Determined by *trying* the login without a TTY, not by
       * reading documentation — neither CLI documents this, and the two
       * measured so far disagree. */
      readonly loginDriver: "pty" | "child";
      readonly callback: McpCallback;
      readonly needsAuthSignal: McpNeedsAuthSignal;
    };

export interface RuntimePortability {
  /** Paths, relative to this runtime's config home, that are entirely the
   * user's own work — skills, subagents, commands, personal instructions —
   * and can therefore be copied byte for byte. Same relative-path
   * convention as `ContextSkillAccounting.dirs`. A path that doesn't exist
   * on a given machine is simply skipped, so listing one a user may not
   * have costs nothing; omitting one they do have loses their work.
   *
   * Never the project instructions file: that one is already declared
   * once, as `identity.projectInstructionsFile`, and lives with the
   * project rather than the config home. Two sources for one fact is how
   * a contract starts lying. */
  readonly authoredPaths: readonly string[];
  readonly mcp: McpContract;
}

// ---------------------------------------------------------------------------
// Quick prompts — a second, much smaller exec-shaped axis for the relay's
// own probes (title generation, next-message suggestion): a short, isolated
// one-shot prompt against this CLI, never a real turn (no session
// persistence, no tool access, no resumable id, nothing a `TurnHost` would
// need to answer). Kept separate from `ExecPlan` rather than folded into it
// — a probe has no `TurnContext` (no `permissionModeId`, no resume), and
// forcing one through `SpawnPerTurnPlan`/`JsonRpcDaemonPlan` would mean
// inventing fake values for fields that don't apply.

export interface QuickPromptContext {
  /** Folded in however this CLI actually honors an instruction override —
   * a literal flag for one CLI (Claude's `--system-prompt`), prepended to
   * `userPrompt` as plain text for one with no such flag (Codex's `exec`) —
   * the def's own `buildArgs` decides which. */
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly cwd: string;
}

/** `"none"` means this CLI has no one-shot mode a probe can drive — honest
 * absence, not a placeholder for something missing; the probe falls back to
 * its own non-CLI default instead of guessing at a mode that doesn't exist. */
export type QuickPromptPlan =
  | {
      readonly kind: "cli";
      readonly buildArgs: (ctx: QuickPromptContext) => readonly string[];
      /** Extracts the model's final reply from raw stdout. Claude's
       * `--output-format text` needs none of substance (the whole trimmed
       * stdout already is the answer); a CLI whose one-shot mode only
       * offers a structured stream (Codex's `exec --json`) picks the final
       * reply out of it here instead of the probe learning that CLI's wire
       * format itself. */
      readonly extractReply: (stdout: string) => string | undefined;
    }
  | { readonly kind: "none" };

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
  readonly quickPrompt: QuickPromptPlan;
  readonly classifyFailure?: (failure: RuntimeFailure) => FailureClass;
  /** Absent for a def with no way to break its baseline down (e.g. a def
   * whose CLI never reports enough to calibrate against) — the client
   * degrades to showing the total only, same shape as every other optional
   * capability in this file. */
  readonly contextAccounting?: ContextAccounting;
  readonly portability: RuntimePortability;
}
