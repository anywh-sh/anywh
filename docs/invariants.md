# Invariants

Rules the codebase is built to hold, with the reasoning behind each one —
so a change that would break one is a decision, not an accident. Two kinds:
enforced today (a lint rule or a test fails if you break them) and
directional (the folder split anticipates them, but the code that would
make them literally true hasn't landed yet). Each entry says which.

## The golden rule: no billed credential reaches a spawned child

**Enforced** — `no-restricted-syntax` in `relay/eslint.config.js`.

A credential that makes an agent bill per token (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` today) must never reach a process this relay spawns —
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

Three violations of this predate the rule and are declared, not hidden:
inline `eslint-disable-next-line import-x/no-restricted-paths` comments
name each one, explain why, and say which phase of the current multi-agent
plan removes it. They're visible on the line specifically so grep finds
them — see the comments themselves for the current list rather than
duplicating it here, since duplicating it is exactly how this kind of note
goes stale.

## Directional: a def is pure data + parsers, never a process

**Not yet enforced — today's `runtimes/defs/claude/session.ts` spawns the
`claude` process directly.** The folder split (`runtimes/defs/claude/`
holding Claude-specific knowledge, separate from wherever the actual
`spawn`/stdout-reading logic ends up) exists so that a def's functions —
building argv, parsing a stream, classifying a failure — can eventually be
plain data and pure functions, testable against a recorded fixture without
the real CLI installed and without touching `child_process`, `fs`, `net`,
or `http`. Getting there means extracting the spawn-and-parse machinery
into a shared engine that every spawn-per-turn-shaped agent reuses, with
the def itself reduced to argv-building and event-mapping. That extraction
hasn't happened yet, so a test asserting "no file under `runtimes/defs/**`
reaches those four built-ins" would be red on arrival — it lands once the
engine exists, not before, so it can start green and stay that way.

## Directional: the relay never guards a second turn's context on its own memory

**Not yet enforced.** The relay treats the agent CLI as the owner of
conversation continuity across turns — it resumes via whatever mechanism
the CLI provides (a session id, a resume flag), rather than replaying
history itself. A def that reassembled and resent the whole transcript
"just to be safe" would work, but the token cost lands on the user for
context the CLI already had. This matters once a second agent's def
exists: a spawn-per-turn CLI and a long-lived daemon CLI keep continuity in
different places, and neither should route through the relay reassembling
state it doesn't need to own.

## Enforced: the wire vocabulary is versioned, and the two copies of the version stay in sync

**Enforced** — `protocolVersionParity.test.ts` (client) fails the build if
`relay/src/protocol/version.ts` and `client/src/lib/protocolVersion.ts`
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

## Directional: killing a turn never destroys the session

**Not yet enforced as a test — enforced today as the only behavior that
exists.** Stopping a turn (`stop_turn`) has to leave the session resumable:
the next message continues the same conversation, not a fresh one. The
current implementation sends the child `SIGINT` and expects a clean exit
with a `session_id` still attached, never a hard kill of anything that
would forget where the conversation was. A future agent whose "stop" means
tearing down a longer-lived process must still uphold this — the button in
the UI can't quietly turn into "start over".
