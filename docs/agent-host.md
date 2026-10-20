# The agent host

A per-profile service, `anywh-agent-host@<profile>`, next to that profile's
relay, built from the same package (`relay/dist/agentHost/main.js`). It owns
long-lived agent processes so that restarting the relay — a deploy, a crash,
a `systemctl restart` — leaves every agent and every turn in flight running.
The relay is a client of it over a unix socket (`relay/src/agentHost/`).

Today only the relay's `GET /agents/activity` uses it; ordinary chat sessions
still spawn one `claude -p` per turn inside the relay.

## Pieces

```
relay/src/agentHost/
  main.ts          service entrypoint (env-configured, drains on SIGTERM)
  agentHost.ts     agents, their state, hibernation, drain, restore
  claudeProcess.ts one long-lived `claude` per agent, its own process group
  codexPool.ts     one `codex app-server` per host, one thread per agent (skeleton)
  processTree.ts   finding and ending every process of an agent
  eventLog.ts      per-agent append-only log (seq + offset, segments)
  socketServer.ts  the socket: handshake, requests, log streaming
  hostClient.ts    the relay's side: reconnect, replay, dedupe
  protocol.ts      the wire, versioned
  registry.ts      what survives a host restart
relay/src/runtimes/defs/claude/persistent.ts   argv/stdin of the persistent CLI
relay/src/routes/agents.ts                     GET /agents/activity
infra/systemd/anywh-agent-host@.service.template
```

## Protocol

Newline-delimited JSON over the socket. The first message is
`{"op":"hello","version":N}`; a host speaking another version answers
`hello_refused` (with both releases) and closes — relay and host come from
the same release, and a mismatch during an upgrade is refused rather than
half-understood. Then:

- `request` (`id`, `method`, `params`) → `response` (`ok` + `result`, or an
  `error` with a stable `code`). Methods: `spawn`, `send`, `interrupt`,
  `stop`, `remove`, `hibernate`, `mark_awaiting`, `activity`.
- `subscribe` (`agentId`, `fromOffset`, `incarnation`) → that agent's log
  from the offset, then live: `event` records (`seq`, `off`, `next`, `t`,
  `ev`), one `caught_up` when the replay reaches the end, `replay_gap` when
  retention dropped what was asked for, `stream_closed` when the agent is
  removed. Every streamed message carries `sub` (the subscribe's id), so a
  replaced subscription's records still in flight are dropped. Each log has
  an incarnation id: an agent removed and recreated under the same id
  starts over at seq 0, and a cursor from the old incarnation is answered
  `reset: true` and read from the new log's start. A malformed subscribe
  is answered with `bad_request` under its id.
- `agent_state` is pushed to every connection on any change.

The relay's client refuses (status `unsafe`) a socket or socket directory
that is not owned by the user or is open to others, before sending
anything.

`ev` is the agent CLI's own event verbatim (stream-json for Claude, the
notification for Codex) or one of the host's `host_*` events (user message,
process spawned/exited/lost, interrupt).

## Log, replay, backpressure

Each record carries its logical byte offset; a client resumes from the
`next` of the last record it processed and drops anything with a `seq` it
already has, so a reconnect never loses or repeats an event. Segments rotate
at 4 MiB; a sealed segment drops its partial-message lines (`stream_event`)
without moving any offset; past 64 MiB the oldest segments go. A subscriber
whose socket buffer passes 1 MiB is moved back to reading from disk, so a
stalled client costs the host a bounded amount of memory. A record is at
most 1 MiB: a larger event (a huge tool result) is stored truncated —
type, subtype, session id, original size and the start of its JSON, marked
`host_truncated`. A write error (disk full, I/O) fails that agent
(`failed`, `log_error: ...`) and never the host.

## Agents

One `claude -p --input-format stream-json --output-format stream-json
--verbose` per agent, in its own session and process group, with the
relay's child environment (billed credentials stripped) and the agent-worker
settings (the user's MCP servers through a 0600 file; no personal plugins,
skills or hooks). States: `starting`, `working`, `awaiting_user`, `idle`,
`hibernated`, `stopped`, `failed`.

- A message sent while a turn is in flight is answered `duringTurn: true`:
  the CLI folds it into that turn at its next tool boundary ("steering")
  instead of running it as the next turn.
- `interrupt` ends the turn in flight (a foreground command and a native
  subagent die; a background command survives) and keeps the process.
- `stop`/`remove`: SIGTERM to the process and its group (the CLI ends its
  tools' processes on SIGTERM), SIGKILL to the group after a grace period,
  then every process still carrying the agent's environment marker is
  ended — the CLI's Bash tool runs each command in its own process group,
  out of reach of the group signal.
- Hibernation ends the process of an agent with no turn in flight and no
  background task, keeping its session; the next message resumes it with
  `--resume`. Policies: `idle` (10 min), `memory` (only while the agents'
  PSS exceeds 60% of a budget), plus at most 10 live agents per room.
- The idle policy never hibernates an agent that has a process outside its
  CLI's tree (a job it detached on purpose, like a dev server); memory
  pressure, an explicit hibernate or making room in a full room may, and
  the log records it (`killed_detached`). Stop and remove end everything.
- A `result` read after a new message was written does not by itself mean
  the agent is idle: the CLI announces every turn with `system`/`init`, so
  until one arrives (or a short settle shows the message was folded into
  the turn that ended) the agent counts as working.
- Every agent process carries `ANYWH_AGENT_MARK=<host>:<agent>:<run>`; the
  sweeps match only that, never the host's configuration variables, which
  the relay and the host strip from everything they spawn. The host takes
  its profile only from `--profile` (never from `ANYWH_PROFILE`).
- On start, the host first takes an exclusive lock on its id, data
  directory and socket (abstract unix sockets on Linux, released by the
  kernel on death; pid lock files elsewhere), and only then ends processes
  a previous run left behind and restores its agents: those that were
  running come back `stopped` (`host_restart`), resumable, never running on
  their own. A registry that cannot be parsed is kept aside as
  `registry.json.corrupt-<time>`; one that cannot be read fails the start.
- On SIGTERM (or an uncaught error) it drains: turns get 50 s, then are
  interrupted; idle agents are hibernated, agents whose work was cut are
  `stopped` (`host_shutdown`). The unit's `TimeoutStopSec=75` covers this
  and stays under the user manager's ~90 s; a test keeps them in sync.
- Deleting a profile through the relay disables its host in the
  background and then removes its data directory.

## Known limits

- A process that detaches **and** rewrites its environment escapes the
  marker sweep (and the detached-job check); under systemd the unit's cgroup still ends it when the host
  stops, but not when one agent is stopped. Outside Linux (no `/proc`) only
  the process group is covered.
- The socket is protected by permissions only (0600 in a 0700 directory):
  Node exposes no peer credentials.
- Codex agents are a life-cycle skeleton, tested only against a fake
  app-server: approvals are declined, nothing is hibernated per agent, a
  message during a turn is refused, tool processes are not ended per agent.
- macOS: no launchd unit yet, and the Homebrew single binary does not
  include the host.
