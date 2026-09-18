# Invariants

Rules the codebase is built to hold, with the reasoning behind each one —
so a change that would break one is a decision, not an accident. Two kinds:
enforced today (a lint rule or a test fails if you break them) and
directional (the folder split anticipates them, but the code that would
make them literally true hasn't landed yet). Each entry says which.

## The golden rule: no billed credential reaches a spawned child

**Enforced** — `no-restricted-syntax` in `relay/eslint.config.js`.

A credential that makes an agent bill per token (`ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` for Claude, `OPENAI_API_KEY` for Codex, today) must
never reach a process this relay spawns —
not a turn, not a one-shot probe, not the interactive terminal. If one
leaks, the agent starts drawing on paid API usage instead of the
subscription its CLI is already logged into, silently, with no error to
notice by.

`relay/src/runtimes/executables.ts` owns the list
(`BILLED_CREDENTIAL_VARS`) and the one function that strips it
(`stripBilledCredentials`). Every other file reading one of those
credential names off `process.env` is a lint error — a second read site is
how a leak starts, and this makes it a compile-time-adjacent failure
instead of something a code review has to catch by hand. Teaching the
relay a second agent CLI means adding that provider's credential names to
the same list, in the same file — never a second strip site.

## Folder boundary: `where` doesn't know `who`, and a def is not orchestration

**Enforced** — `import-x/no-restricted-paths` in `relay/eslint.config.js`,
zones documented in [`architecture.md`](./architecture.md).

`host/` (where a process runs — paths, the terminal, systemd, git) never
imports from `session/` (orchestration) or `runtimes/` (which agent, and
how). `session/` never reaches past a def's own `index.ts` into its
internals. A def under `runtimes/defs/` never reaches into `session/` for
orchestration state — a def describes an agent, it doesn't decide what a
session does with the result.

One violation of this predates the rule and is declared, not hidden: an
inline `eslint-disable-next-line import-x/no-restricted-paths` comment
names it, explains why, and says which phase of the current multi-agent
plan removes it. It's visible on the line specifically so grep finds it —
see the comment itself (`runtimes/defs/claude/session.ts`) for the current
detail rather than duplicating it here, since duplicating it is exactly how
this kind of note goes stale. Two sibling violations that used to live here
(`transcriptReader.ts` and `host/backgroundJobs.ts`, both reaching for a
Claude-shaped type) are gone as of the wire normalization below — both
depend only on `protocol/agent-event.ts` now.

## Enforced: `session/` never branches on an agent's identity or `exec.kind`

**Enforced** — `relay/architecture.test.ts`'s tripwire on `ExecPlan`'s
variant tags (`"spawnPerTurn"`, `"jsonRpcDaemon"`): a string literal match
outside `runtimes/` fails the build. `session/` codes against the
`AgentSessionDriver` interface (`runtimes/sessionDriver.ts`) only —
`runtimes/createSessionDriver.ts` is the one place outside `registry.ts`
allowed to look at `exec.kind`, picking `ClaudeSessionDriver` for a
`spawnPerTurn` def or `CodexSessionDriver` for a `jsonRpcDaemon` one. A def
that leaked its shape into `session/` (an `if (agentId === 'codex')`,
anywhere outside `runtimes/`) would be exactly the graft this test exists
to catch.

## A def is pure data + parsers; a driver is the process

**Partially enforced.** `runtimes/defs/claude/def.ts` (the `AgentRuntimeDef`
— argv-building, env, capability declarations) is now separate from
`runtimes/defs/claude/driver.ts` (the `AgentSessionDriver` implementation
that owns the actual `claude` child process); Codex's `defs/codex.ts` /
`defs/codexDriver.ts` follow the same split. A def's own functions —
building argv, parsing a stream, classifying a failure — are pure and
testable against a recorded fixture with no real CLI installed and no
`child_process`/`fs`/`net`/`http` (see §8 of `runtimes/README.md`).

What's still directional: today's split is one driver per def, not a
shared engine that a second `spawnPerTurn`-shaped agent could reuse without
`createSessionDriver.ts` changing — its own header comment calls this out
as "honest for a registry of exactly one" on each branch. Generalizing that
dispatch waits for a real second agent of the same `exec.kind` to design
against, same reasoning as `docs/architecture.md`'s note on `probes/` being
agnostic in purpose but Claude-only in today's implementation.

## Directional: the relay never guards a second turn's context on its own memory

**Not yet enforced.** The relay treats the agent CLI as the owner of
conversation continuity across turns — it resumes via whatever mechanism
the CLI provides (a session id, a resume flag), rather than replaying
history itself. A def that reassembled and resent the whole transcript
"just to be safe" would work, but the token cost lands on the user for
context the CLI already had. This is no longer hypothetical: Claude (a
spawn-per-turn CLI) and Codex (a long-lived JSON-RPC daemon) keep
continuity in different places — a session id resumed via a flag for one, a
thread the daemon itself remembers for the other — and neither routes
through the relay reassembling state it doesn't need to own. Every def
declares `continuity: { kind: 'cli-resume' }` today; the one declared,
non-tacit exception is `{ kind: 'relay-transcript' }`, for a CLI with no
resume of its own — see `runtimes/README.md` §1.

## Enforced: the wire vocabulary is versioned, and the two copies of the version stay in sync

**Enforced** — `protocolVersionParity.test.ts` (client) fails the build if
`relay/src/protocol/version.ts` and `client/src/lib/relay/protocolVersion.ts`
diverge, same mechanism as `themeValidatorParity.test.ts` for `theme.ts`.

`WS_PROTOCOL_VERSION` is an integer, not semver, because relay and client
ship from the same repo and the same release — there is no compatibility
range to express, only "same" or "different". The relay announces it as the
first message on every WebSocket connection
(`{ type: "protocol_version", version }`), ahead of history replay or
anything else; a client that finds a mismatch stops there instead of
processing messages it can't be sure it understands correctly, and tells
the user to update instead of quietly misrendering or going blank.

Bump the constant (both copies) whenever a change to the wire vocabulary
would make an *older* client misinterpret a message rather than just not
know about it yet — a new discriminated variant that reuses an existing
`type` differently, not one that simply adds a new one.

## Enforced: the wire speaks `AgentEvent`, never a CLI's own format

**Enforced** — `agentEventParity.test.ts` (client) fails the build if
`relay/src/protocol/agent-event.ts` and `client/src/lib/relay/agent-event.ts`
diverge, same mechanism as `theme.ts`/`protocolVersion.ts`.

`runtimes/streams/claudeStreamJson.ts` is the one place that translates
Claude's raw stream-json shape (`ClaudeEvent`, private to
`runtimes/defs/claude/`) into `AgentEvent` — the relay broadcasts
`{type: "agent_event", event}`, never the raw shape, and turn lifecycle
(`turn_started`/`turn_ended`/`error`) is synthesized by the session layer
itself rather than mapped from any one CLI's output (see `AgentEvent`'s own
doc comment). `useMessageLog.ts` and `host/backgroundJobs.ts` — the two
consumers on either side of the wire — read only `AgentEvent`; neither knows
Claude's content-block shape exists. A second agent's def gets its own
mapper into the same `AgentEvent` vocabulary; nothing downstream changes.

## Directional: killing a turn never destroys the session

**Not yet enforced as a test — enforced today as the only behavior that
exists.** Stopping a turn (`stop_turn`) has to leave the session resumable:
the next message continues the same conversation, not a fresh one. The
current implementation sends the child `SIGINT` and expects a clean exit
with a `session_id` still attached, never a hard kill of anything that
would forget where the conversation was. A future agent whose "stop" means
tearing down a longer-lived process must still uphold this — the button in
the UI can't quietly turn into "start over".
