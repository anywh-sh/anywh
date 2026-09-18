# The agent runtime contract

What `runtimes/types.ts` is for, why each field is shaped the way it is, and
how to add a new agent CLI without becoming the person who has to explain the
contract's history to the next person who tries. Nine sections; each one
exists to prevent one specific, nameable mistake — if a section stopped
preventing anything, it should be deleted rather than kept for completeness.

## §0 — the thesis

**"One process per turn" is not an invariant of this project.** It was an
artifact of how Claude Code's headless mode happens to work — spawn, print
JSON lines to stdout, exit. Codex is a JSON-RPC 2.0 daemon that lives for a
whole session and pushes requests *back* at the relay mid-turn
(`item/commandExecution/requestApproval`, `item/tool/requestUserInput`). A
contract written against the first shape and stretched to cover the second
produces a `def` that lies about what it is, and a `session/` full of
`if (agent === 'codex')`.

`runtimes/types.ts` exists so that adding a second, third, or twenty-seventh
agent CLI is a new file under `defs/`, not a new branch in code that has to
know every agent that came before it. `runtimes/registry.ts`'s
`assertCoherent` is what makes "the def is honest about what it supports" a
function you can call instead of a code-review hope.

## §1 — the four invariants

Everything else in this document is in service of these four. A `def` that
violates one of them is wrong regardless of how cleanly it typechecks.

1. **The relay never guards a second turn's context on its own memory. The
   CLI is the owner.** *Typical violation:* a def that resends the whole
   transcript on every turn "just to be safe" — and the token bill lands on
   the user for context the CLI already had. The one declared, non-tacit
   exception is `continuity: { kind: 'relay-transcript' }`, for a CLI with no
   resume of its own.
2. **Every privileged turn-scoped resource is scoped to something that dies
   with the turn.** A call arriving outside an active turn is *rejected*, not
   queued. *Typical violation:* a long-lived daemon registering a bridge
   endpoint once per session "for efficiency" — leaving a process that has
   already exited still holding a valid credential.
3. **Killing a turn never destroys the session's continuity.** *Typical
   violation:* `interrupt()` tearing down the daemon — the Stop button
   quietly becomes `/clear` in disguise. This is why both `ExecPlan` variants
   carry their own interrupt shape (`{ signal, expectsCleanExit }` for a
   spawn, `turn.interrupt(threadId, turnId)` for a daemon) instead of one
   generic "kill it" the engine has to guess the right meaning of.
4. **Restarting the relay never loses anything that resuming can't recover.**
   What survives a restart is persisted data, never in-memory process state.

Above all four, the golden rule: **no credential that bills per token ever
reaches a spawned child** — not a turn, not a probe, not the embedded
terminal. Enforced today by `no-restricted-syntax` in `relay/eslint.config.js`
(see `docs/invariants.md`); a def's job is only to *declare* its credential
names in `identity.env.strip`, never to strip them itself.

## §2 — the contract, field by field, and the data/code boundary

> **Data is everything the UI, the control plane, or `assertCoherent` need to
> know without opening a connection. Code is everything that needs a live
> process — and that lives in the engine, never in the def.**

| Field | What it answers | Data or code |
|---|---|---|
| `identity` | which binary, which env vars to strip/set, which file it reads for project instructions | data |
| `capabilities` | what this agent can do, at what level (`native`/`bridged`/`none`) | data |
| `continuity` | who owns conversation history across turns | data |
| `models` | where to find the model list — a probe's args + a pure parser, or "ask the daemon" | data + a pure function |
| `auth` | same shape as `models`, for login status | data + a pure function |
| `permissions` | a function from host platform to available modes, and which one is default | a pure function |
| `bridges` | which of today's three bridge files this agent uses, if any | data |
| `exec` | the union: how a turn is actually driven | data + pure functions |
| `quickPrompt` | how to run a short, isolated one-shot prompt for the relay's own probes (title/suggestion generation) — never a real turn | data + a pure function, or `{ kind: "none" }` |
| `classifyFailure` | turns raw failure text/code into one of a fixed set of classes | a pure function |
| `contextAccounting` | calibrated constants for breaking this def's context-window baseline down by category — absent when the CLI never reports enough to calibrate against | data, or absent |

The def's own functions (`buildArgs`, the stream mappers, `thread.start`,
`turn.start`, `handleServerRequest`, `classifyFailure`, a `models`/`auth`
`parse`) are **pure** — no `spawn`, no `fs`, no `net`, no clock. Effect lives
in that agent's own `AgentSessionDriver` implementation
(`runtimes/defs/claude/driver.ts`, `runtimes/defs/codexDriver.ts`) and in
`runtimes/detection.ts`. `runtimes/createSessionDriver.ts` is the one place
outside `registry.ts` allowed to branch on `exec.kind`, picking the right
driver for a def — `session/` only ever sees the `AgentSessionDriver`
interface (`runtimes/sessionDriver.ts`), never the branch. Today that's one
driver per def, not a shared engine a second `spawnPerTurn` agent could plug
into without `createSessionDriver.ts` changing — see its own header comment.
That a def's functions stay pure regardless is what lets a def's test be a
table fed a recorded stream fixture, with no real CLI installed — see §8.

Derived rule: **if a field would need to spawn something to answer, it isn't
a field on the def — it belongs in detection, at runtime.**

## §3 — choosing the execution axis

Three questions decide which `ExecPlan` variant a new agent gets. If the
answer to all three is "yes", it's `spawnPerTurn`; if the CLI is a daemon
that answers "no" to the first, it's `jsonRpcDaemon`.

1. **Does the CLI exit when the turn ends?** A daemon that outlives the turn
   (Codex, any ACP agent) cannot be `spawnPerTurn` — there is no process to
   wait on per turn, only a thread/session id to keep referencing.
2. **Does it ever need to ask the relay something mid-turn, unprompted?**
   `spawnPerTurn`'s only channel is stdout, read passively. A CLI with a
   native approval or structured-input request
   (`item/commandExecution/requestApproval`) needs a transport that can carry
   a message the *other* direction — `handleServerRequest` only exists on
   `JsonRpcDaemonPlan`.
3. **Is its stream format a sequence of self-contained lines, or a
   request/response protocol?** `claude-stream-json`-shaped output (one JSON
   value per line, no correlation id) is `spawnPerTurn` even if verbose;
   anything with request ids and a spec (JSON-RPC 2.0) is a daemon plan,
   regardless of framing (see `framing: 'ndjson' | 'lsp-headers'` — Codex and
   ACP both answer "daemon" here but frame differently).

`CustomPlan` exists for the shape nobody has hit yet — a wrapped subprocess
pool, a remote HTTP-only agent. Declared now as a closed union member so it
doesn't get added later as an afterthought exception.

## §4 — capabilities: the table, and when a field deserves to exist

| Capability | `native` looks like | `bridged` looks like | `none` looks like in the UI |
|---|---|---|---|
| `presentChoice` | ACP-style structured input request | today's `mcpBridge.ts` `present_choice` tool | the agent's own free-text answer, no card |
| `approvalPrompt` | a server->client approval request (Codex, ACP) | `permissionBridge.ts`'s `--permission-prompt-tool` | the CLI's own default handling, unobserved by the relay |
| `rewindTurn` | a daemon method that truncates its own thread | — (no bridge backs this today) | edit-message/rewind hidden from the UI entirely |
| `replayHistory` | a daemon method that replays prior turns | — | history paging falls back to whatever the relay itself persisted |
| `backgroundJobs` | tool-result parsing keyed to a known event shape | — | no background-job tracking offered |
| `thinking` | a distinct reasoning/thinking stream | — | thinking simply never renders |
| `contextUsage` | usage numbers on every turn | — | the context-usage indicator doesn't render |

A capability only earns a place in `AgentCapability` when all three are true:
the UI visibly changes when it's `"none"`; a real runtime exists today where
it's `"none"` or `"bridged"` *and* another where it's `"native"` (otherwise
it's not a capability, it's a fact about one agent); and the value is knowable
without running the agent. If a candidate field fails the third test, it
belongs in `runtimes/detection.ts`, not here — see the derived rule in §2.

## §5 — permission modes

`PermissionPolicy<TSettings>.modesFor(platform)` is a function, not a flat
list, because coverage genuinely differs by host OS. The worked example:
Codex's `workspace-write` sandbox mode has no Windows implementation. On
`win32`, `modesFor` simply omits it — the mode is **absent**, not present and
silently weaker, which is the distinction that matters: a user on Windows
should see fewer choices, never a choice that quietly does less than it
claims. `defaultModeId` only has to survive `modesFor` on *at least one*
platform, which is what makes this representable at all — see
`runtimes/defs/codex.ts`, the actual worked case, and
`runtimes/registry.test.ts` for the coherence check this enables.

`TSettings` is opaque outside the owning engine on purpose: Claude has one
permission axis (`default`/`acceptEdits`/`plan`/`bypassPermissions`), Codex
has two orthogonal ones (`sandboxMode` × `askForApproval`). Neither engine
needs to know the other's shape exists.

`label` is `labelKey` everywhere in this contract (`PermissionMode`,
`ApprovalDecision`, `ModelOption`) — a def declares an i18n key, never
hardcoded UI text, per `CONTRIBUTING.md`'s language rule. The one exception
is `ApprovalRequest.summary`, which is *not* a `labelKey`: it describes one
specific command or tool call, not static chrome, so it's plain text by
necessity.

## §6 — bridges

A bridge (`bridges/mcpBridge.ts`, `permissionBridge.ts`,
`planChoiceMarker.ts`) is a workaround validated against one real CLI binary,
not a shared interface every agent must implement. A def's `bridges` array
names which of today's bridges it actually spawns; an **empty array is
correct**, not a gap — it means the agent needs none of them, either
because it has native equivalents (Codex, ACP) or because it has no
equivalent at all (degrading honestly to `"none"` in `capabilities`,
per §4).

Adding a bridge for a new agent: a new file in `bridges/`, named for the
agent when it isn't shareable (`codexPermissionBridge.ts` if Codex ever
needs one that doesn't fit the MCP-based pattern), without trying to
generalize it into the three that already exist. **No type contract in this
file substitutes for validating a bridge against the real binary** — every
existing bridge's header comment says exactly that, because a bridge is
where the relay talks to a process it doesn't control the source of.

## §7 — the Claude def, read as the worst case

`runtimes/defs/claude/` has grown the shape this contract describes — `def.ts`
(pure) separate from `driver.ts` (the `AgentSessionDriver` implementation
that actually owns the `claude` process). Read it as the **worst-served**
member of the registry, not the reference implementation the contract was
designed around:

- `classifyFailure` has no numeric code to work with — Claude Code's failures
  are prose on stderr, so classification is regex against text, the same
  fragility `isSessionInvalidError` has today.
- `approvalPrompt` is `"bridged"`, never `"native"` — `--permission-prompt-tool`
  is a workaround (`permissionBridge.ts`), not a first-class protocol
  feature.
- `ApprovalRequest`/`UserInputAnswer`'s `reason` (why a decision was made) is
  always `undefined` for Claude — the CLI has no channel to report one.

Designing the contract around Codex or ACP instead would have produced a
`classifyFailure(failure: RuntimeFailure)` that assumed a `code` always
exists, an `approvalPrompt` that assumed a real transport, and fields no
spawn-per-turn CLI could ever fill in. The contract has to fit its worst
member as comfortably as its best one, or the "worst" member is the one that
proves it was never generic in the first place.

## §8 — testing a def without the CLI installed

Because every def function is pure (§2), a def's test is a table: feed
`mapStdoutLine` a recorded raw line, or `mapNotification` a recorded
`(method, params)` pair — a daemon's transport already parses the envelope,
so there's no raw line left for the def to re-parse — and assert the
`AgentEvent`s each produces; feed `classifyFailure` a `RuntimeFailure`, assert the class;
call `buildArgs`/`thread.start`/`turn.start` with a `TurnContext`, assert the
argv or request. None of this requires the real binary, which is what makes
`assertCoherent` and a def's own tests runnable in CI without a Claude/Codex
account logged in anywhere.

The one rule that keeps this honest: **every recorded fixture states the
exact CLI version that produced it**, in the fixture file itself or its
directory name. `runtimes/probes/defaultModel.ts`'s comment already tells the
story of what happens without this — a CLI update silently changed its
output format (wrapping a value in markdown backticks) and a probe broke
without anyone noticing, because nothing pinned the fixture to a version that
could go stale. A fixture with no version is folklore, not a test.

## §9 — checklist for a new def

- [ ] `identity.env.strip` names every credential this CLI could bill through
      if it leaked (`assertCoherent` requires at least one).
- [ ] Every `capabilities` entry is deliberately `"native"`, `"bridged"`, or
      `"none"` — never left at a default, since there is no default.
- [ ] If any capability is `"bridged"`, the matching bridge id is in
      `bridges` (`assertCoherent` checks this for `presentChoice`/`mcp` and
      `approvalPrompt`/`permission`).
- [ ] `permissions.modesFor` returns at least one mode on all six
      `HostPlatform` values, and `defaultModeId` survives on at least one of
      them.
- [ ] If `approvalPrompt` is `"none"`, no mode anywhere sets
      `pausesForApproval: true`.
- [ ] `exec.kind` is chosen using the three questions in §3, not by copying
      whichever existing def looks closest.
- [ ] Every function on the def is pure — no `child_process`, `fs`, `net`,
      or `http`, per §2's derived rule.
- [ ] A characterization test exists for every pure function, against a
      fixture that names the exact CLI version it was captured from (§8).
- [ ] `assertCoherent(def)` passes with zero issues before the def is wired
      into `runtimes/registry.ts` for real.
- [ ] If this def declares `contextAccounting`, its `multiplier`/`perFile`/
      `emptyDirectoryInflation` constants are calibrated against the real
      CLI, not guessed — a paired diff (empty directory vs. one holding only
      the rule file, both runs at least twice to rule out a first-run
      warm-up cost) against the chosen `encoding`'s raw token count, with the
      exact CLI version that produced them recorded in a comment next to the
      constants (a fixture — or a constant — with no version is folklore,
      not a test). Absent `contextAccounting` is a legitimate answer for a
      CLI that never reports enough to calibrate against, not a gap to fill
      in later.
