# Architecture

What lives where, and why — the folder-level map. [`CONTRIBUTING.md`](../CONTRIBUTING.md)
covers `relay/` vs `client/` vs `infra/systemd/` at the top level; this
document is about what's inside `relay/src/`, since that's the one that
used to be 50 flat files with no folder to tell a reader what depended on
what.

## The two axes: `who` and `where`

Two folders answer two different questions, and the split exists because
the codebase used to answer both with "the Claude Code CLI" and that
stopped being true the moment a second agent CLI became a real target.

- **`runtimes/`** answers **who** — which agent CLI, and how it's driven.
  Note the deliberate naming fight: in the devcontainer/Coder world
  "runtime" usually means *where* code executes. This repo needs the word
  for *who* instead (which agent), so `host/` below carries the *where*
  meaning that "runtime" would otherwise have claimed.
- **`host/`** answers **where** — the machine the relay itself runs on:
  paths, the embedded terminal, systemd profile files, git status. Code
  here has no idea which agent CLI exists, and doesn't need to.
- **`session/`** is orchestration — turn lifecycle, broadcast to connected
  clients, the approval/choice state machine, history paging. It knows
  *that* an agent ran, and reads a def's public surface to drive one, but
  doesn't know a def's internals.

## The tree

```
relay/src/
  server.ts              composition root — see below, it does not move
  protocol/               type guards for every WS message and HTTP body
                           (guards.ts), the WS handshake version
                           (version.ts), and the normalized event vocabulary
                           every def's stream maps into (agent-event.ts) —
                           the latter two mirrored verbatim on the client,
                           see each file's own doc comment
  runtimes/
    types.ts               the agent runtime contract — what a `def`
                           is, independent of any one agent CLI. See
                           runtimes/README.md for the full rationale.
    registry.ts             assertCoherent() plus the fail-isolated
                           registry builder that runs it
    executables.ts        agent-CLI-binary resolution, PATH, credential strip
    probes/                title/suggestion/default-model generation —
                           agnostic in purpose, Claude-only in today's
                           implementation
    streams/                per-agent mappers from a raw CLI stream into
                           `protocol/agent-event.ts`'s `AgentEvent` — the
                           only thing outside a def allowed to know that
                           def's private wire format, since it exists to
                           translate it away
    sessionDriver.ts        the `AgentSessionDriver` interface — everything
                           `session/` is allowed to know about "whichever
                           agent CLI is driving this session", so it never
                           branches on an agent's identity or its `exec.kind`
    createSessionDriver.ts  the one place outside `registry.ts` allowed to
                           branch on `exec.kind` — picks a concrete driver
                           for a def (`ClaudeSessionDriver` for a
                           `spawnPerTurn` def, `CodexSessionDriver` for a
                           `jsonRpcDaemon` one)
    defs/claude/           Claude's own knowledge: process spawn, stream
                           parsing, on-disk transcript format
      def.ts                 the pure `AgentRuntimeDef` — argv, env, capability
                           declarations, no `spawn`
      driver.ts              the effectful half: owns the actual `claude`
                           child process, implements `AgentSessionDriver`
      index.ts              the ONLY file anything outside this folder may
                           import from — see "the index.ts rule" below
    defs/codex.ts, defs/codexDriver.ts   Codex's def and driver, the same
                           def/driver split as Claude's — registered in
                           `server.ts` alongside Claude's, not a draft
    defs/acp.ts             still a design-validation draft, not a registered
                           def — proves the contract survives a third agent
                           shape (a daemon that speaks JSON-RPC over headers
                           instead of Codex's newline framing) before any
                           engine consumes it
  session/                turn orchestration, broadcast, approval/choice
                           state machine, history paging — drives whichever
                           `AgentSessionDriver` `createSessionDriver.ts`
                           handed it, never an agent's identity directly
  bridges/                 MCP servers the relay runs for a turn to call
                           back into (present_choice, permission prompts,
                           plan-mode's text-marker fallback)
  fs/                      the file panel's own read/write/browse of a
                           session's working directory
  portability/             reading and writing a runtime's *config home*
                           (`~/.claude`, `~/.codex`) so a setup can be
                           carried to another machine or profile — the
                           files a def calls the user's own, plus the
                           allowlisted slice of its MCP declaration, never
                           a credential. Separate from `fs/` because that
                           one is rooted at the session's cwd by
                           construction and cannot reach a config home at
                           all
  host/                    machine-local concerns: paths, the embedded
                           terminal, profile registry, theme validation,
                           git status, background-job tracking
```

## `server.ts` doesn't move

It's the composition root: config from env, the singletons, the ordered
list of route/message handlers, the two HTTP listeners (the public one and
the loopback-only one the MCP bridges use). Composition roots live outside
what they compose — putting it inside `runtimes/`, `session/`, or any
other folder it wires together would be structurally dishonest about what
the file is. It's also what the integration tests import for its side
effects (`relay/tests/helpers/testServer.ts`), so keeping it in place kept
those 13 tests untouched by the folder split.

## The `index.ts` rule

Nothing outside `runtimes/defs/claude/` may import a file from inside it
other than `index.ts`. This is the clause that keeps a second agent's
private format — its own transcript shape, its own process-spawning
detail — from leaking into `session/` or `server.ts` the way Claude's did
before this existed. `import-x/no-restricted-paths` enforces it; a def
that grows a second internal file re-exports through the barrel, it
doesn't get imported around it.

One import predates this split and reaches across a boundary the rule
would otherwise catch: `runtimes/defs/claude/session.ts` borrows
`PermissionMode`/`ModelChoice`/`ContextUsage` from `session/sessionStore.ts`.
It's declared inline (`eslint-disable-next-line` with a comment) rather
than hidden, and names the phase of the current multi-agent-CLI plan that
removes it (once this def declares its own settings shape instead of
borrowing `session/`'s). Two sibling violations — `transcriptReader.ts` ->
`session/sharedSession.ts` and `host/backgroundJobs.ts` ->
`runtimes/defs/claude/session.ts` — used to live here too; both are gone as
of Phase 7, now that a normalized `AgentEvent` (`protocol/agent-event.ts`)
replaced the Claude-shaped types they used to reach across the boundary for.

## `client/`

`src/lib/` and `src/hooks/` are grouped into the same topic clusters on
both sides — `relay/`, `profiles/`, `theme/`, `install/`, `platform/`,
`format/`, `composer/`, plus a handful of thin single-store wrappers left
at the root of each (`settings.ts`, `useFirstRun.ts`, and similar). The
split is mechanical, the same way the relay's was: every file moved
verbatim, only import specifiers and path literals changed.

`App.tsx` follows the relay's `server.ts` pattern: it stays a composition
root and does not grow the logic it wires together. What used to be nine
`handle*` functions and two `keydown` listeners inline in the component
now live in their own hooks, called from `AppShell` and passed the pieces
of state (`tabsState`, `sessionDock`, and so on) they act on:

- `hooks/useKeyboardShortcuts.ts` — a pure `key → command` table
  (`matchShortcut`, unit-tested with no DOM) plus the `window.addEventListener`
  wiring around it.
- `hooks/useSessionActions.ts` — creating, selecting, renaming and deleting
  a session/tab.
- `hooks/useLayoutCommands.ts` — the nine commands that move panels, panes
  and tab focus around (terminal/files toggle, tab cycling, group split,
  sidebar toggle).
- `hooks/useProfileSwitching.ts` — the three ways the active profile
  changes (sidebar pick, and `ProfileSetupDialog`'s two exits).
- `hooks/useTabPanelActions.ts` — assembles the single `TabPanelActions`
  object every tab's panel calls back into, built once via `useMemo` so
  `TabPanel` can stay `memo`'d.

`App.tsx` itself keeps the state each of these needs, the effects that
don't belong to any one of them (first-launch tab restore, notification
permission, the update-check interval), and the JSX.

## Further reading

- [`runtimes/README.md`](../relay/src/runtimes/README.md) — the agent
  runtime contract itself: what a `def` is, the four invariants, and why
  each field in `runtimes/types.ts` is shaped the way it is.
- [`invariants.md`](./invariants.md) — the rules this structure exists to
  make enforceable, several of which aren't fully true yet (the def-purity
  one, in particular) and say so.
- [`extract-test-refactor.md`](./extract-test-refactor.md) — the commit
  workflow used to get an existing file to a new location or a new shape
  without changing its behavior along the way.
