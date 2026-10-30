# Plan usage

The status bar shows how much of each agent's plan is spent: Claude Code's
5-hour and weekly windows, Codex's windows (30 days on the free plan, 5 hours
and a week on paid plans). Each profile's relay reads the CLI logged in on its
own machine. Nothing leaves that machine, and nothing goes through a hosted
service.

This page covers where the numbers come from, what reading them costs, and the
limits of each source.

## Sources

| Agent | Source | Cost | When |
|---|---|---|---|
| Claude Code | `rate_limit_event` in the stream of a turn the relay runs | none: the turn was happening anyway | at the end of every turn |
| Claude Code | a **probe**: a minimal `claude -p` turn whose only purpose is that event | a few tokens of Haiku, from the subscription | see [The Claude probe](#the-claude-probe) |
| Claude Code | `claude auth status --json`, and the tier keys of `~/.claude.json` | none (no turn) | on connect, and every 4 minutes while logged out or unknown |
| Codex | app-server `account/read` + `account/rateLimits/read` | none: it asks the backend, starts no turn and spends no quota | every minute while a client is connected, when the card opens, after a Codex turn |
| Codex | app-server `account/rateLimits/updated` | none | pushed by the CLI during turns |

The relay never calls a private usage endpoint with the CLI's credentials,
never reads a token, and never reads `~/.codex/auth.json` (it only checks
that the file exists, to know whether Codex is logged in before starting an
app-server). From `~/.claude.json` it reads, by key, only the rate limit tier
(to tell "Max 5x" from "Max 20x") and the account and organization ids
(hashed at once, see [Privacy](#privacy)).

None of these fields is a documented contract. `unifiedWindows` in Claude's
event and the Codex plan type list can change with any CLI release. The relay
parses them defensively: a window it can't read is dropped, never guessed, and
an unknown plan type is shown as it comes.

## The Claude probe

Claude Code has no read-only way to ask for the usage: every reading is a
turn. A turn on an account whose 5-hour window has expired **opens a new
window**, anchored at the probe instead of at the next real use. So the relay
probes on its own only when that can't happen:

- at least one client is watching this profile (`/plan-usage/watch`);
- the last known 5-hour window is still active, with a minute to spare;
- the account isn't at its limit (a limited account is left alone until the
  reset);
- no turn is running on the profile (it brings its own reading), and no other
  probe is in flight;
- every 4 minutes at most.

With the window expired or never seen, the relay doesn't probe on its own. The
window shows 0 % until one of these happens:

- a turn runs through anywh;
- a Claude transcript of the profile was written in the last 10 minutes and
  after the last known reset (use in a terminal or an editor), which means a
  window was open a moment ago. Without a known reset (a profile never read)
  this doesn't apply: a write says a window was open then, not that it still
  is;
- the person presses the refresh button. **The button always probes**, and
  with an expired window that opens a new one. That is intended: it is an
  explicit request.

A login without a subscription (an API key, Bedrock) is never probed: the
relay strips the billed credentials from the probe's environment, and checks
`authMethod` before spawning, so the turn can't bill per token.

The probe runs `claude -p` with `--no-session-persistence`, no tools, no MCP
servers, no slash commands, one turn, on Haiku, from an empty directory of its
own. It leaves no session in the history.

### Kill switch

`ANYWH_PLAN_USAGE_PROBE=0` in the profile's `.env` turns every probe off,
automatic or forced. Claude's numbers then come only from real turns; the plan
and login state are still read. Codex is unaffected: reading it costs nothing.

## Terms of service

This is an engineer's reading, not legal advice.

- **Claude, turn events**: reading what the unmodified CLI prints during the
  user's own turns. Fine.
- **Claude, probe**: `claude -p` is documented for scripts and scheduled jobs,
  and draws from the subscription's limits. A tool that runs it unprompted to
  read usage is a grey area, which is why it is rare (≤ 15 per hour per
  profile, only while someone is watching), never opens a window on its own,
  and can be switched off.
- **Codex, app-server**: rate limits are part of the documented app-server
  protocol, read with the official client identifying itself as `anywh`.
  Fine.
- Not used, on purpose: Claude's OAuth usage endpoint (it means handling the
  CLI's credentials as another client) and ChatGPT's `backend-api` usage
  endpoint (automated extraction its terms rule out).

## Privacy

The client needs to know when two profiles are logged in to the same account,
to show it once. The relay sends an opaque `accountKey` for that:
`HMAC-SHA256(salt, agent, kind, part1, part2)`, truncated to 16 hex
characters, where the parts are Claude's account and organization ids (or
e-mail and organization, from `claude auth status`) and Codex's e-mail and plan.
The salt is 32 random bytes in `~/.config/anywh/account-salt` (mode 0600),
shared by every relay of the machine so keys can be compared across profiles,
and never sent. A pair with a part missing gets no key, and the accounts are
shown apart.

No e-mail, account id, token or tier string reaches the client, the relay's
log or the snapshot the relay keeps on disk
(`<sessions file>-plan-usage.json`, mode 0600, so a restart doesn't start from
nothing).

## Protocol

A dedicated WebSocket per profile, `/plan-usage/watch`:

- relay → client: `{type: "plan_usage_state", runtimes, observedAt}` on
  connect and on every change; `{type: "pong"}`. While a read of a runtime is
  in flight (a Claude probe takes about 5 s, a Codex read about 1 s), its
  entry carries `reading: true` and `readingSince`; the state pushed when the
  read starts says so, and the one pushed with its result no longer does;
- client → relay: `{type: "plan_usage_refresh", runtime?, force}`, answered
  with a fresh `plan_usage_state` once the reads end; `{type: "ping"}`.

The types are in `relay/src/planUsage/types.ts`, mirrored in
`client/src/lib/planUsage/model.ts`. Liveness is client-initiated (`ping`),
never a server timer, so an idle machine isn't kept awake. Each open socket
counts as a connected client; with none, the relay reads nothing on its own
and stops its Codex app-server.

`GET /plan-usage` returns the same snapshot, for debugging.

**Older relays.** A relay without this feature does not answer the path with
an error. It treats the socket as a chat connection, whose first message is
`protocol_version`. The client takes that first message as "not supported",
closes the socket and doesn't retry. On that older relay, opening the app
touches the default session once per launch. Nothing else changes, and the
feature needed no `WS_PROTOCOL_VERSION` bump.

## Known limits

- With the window expired, use on another device (claude.ai, another
  machine) shows up only after the next anywh turn or a refresh.
- Codex paid plans (5 hours + a week) follow the protocol's types. They have
  not been measured against a real paid account.
- Two profiles logged in to the same account each probe on their own schedule.
- macOS (Keychain, a different `$HOME` layout) is untested.
