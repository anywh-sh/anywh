# Configuration

Every setting on both sides, what it defaults to, and when you actually need
to change it. Nothing here is required — a relay started from a shell that
already has your agent CLI on PATH runs on defaults alone.

## Where settings live

The relay reads, in increasing order of precedence:

1. `relay/.env` — shared by every profile on the machine. Put machine-wide
   things here: `AGENT_BIN`, `EXTRA_PATH_DIRS`.
2. `~/.config/anywh/env/<profile>.env` — one file per profile, written by
   `add-profile.sh`. Put per-profile things here: `RELAY_PORT`,
   `RELAY_HOME_OVERRIDE`.
3. A real environment variable, which always wins over both.

The same two files work whether you run `npm start` from a shell (loaded via
Node's `--env-file-if-exists`) or under systemd (loaded via
`EnvironmentFile=`). Neither is committed; both are gitignored.

## Relay

### Agent process

| Variable | Default | What it does |
|---|---|---|
| `AGENT_BIN` | `claude`, resolved via PATH | Absolute path to your agent CLI's binary. Set it whenever the relay's own PATH can't resolve the bare name — which is most of the time under systemd, since the service never sources your shell profile. |
| `EXTRA_PATH_DIRS` | — | Colon-separated directories prepended to the PATH of every spawned agent process, for tools the agent itself invokes (`node`, `git`, a version manager's shim directory). Same PATH problem as above, one level down. |
| `RELAY_HOME_OVERRIDE` | your real `$HOME` | Overrides `$HOME` for the spawned agent, which is how one machine runs several isolated logins. See [Profiles](./profiles.md). |
| `TMUX_BIN` | the standard system path | Absolute path to `tmux`, used by the terminal panel. |

`CLAUDE_BIN` is the former name of `AGENT_BIN`. It still works so an
existing `.env` survives an upgrade untouched, but it's deprecated — use
`AGENT_BIN` in anything new.

The relay strips the provider's API key from the environment of every agent
process it spawns. That is deliberate and not configurable: it guarantees
usage bills against the subscription the CLI is logged into, never
pay-per-token.

### Network

| Variable | Default | What it does |
|---|---|---|
| `RELAY_HOST` | `127.0.0.1` | Interface the relay binds to. `0.0.0.0` listens everywhere — read the [security model](../README.md#security-model) before you do, because the relay is unauthenticated and defaults to a permission-skipping agent. A tailnet IP is usually what you want instead. |
| `RELAY_PORT` | `8765` | Port for the HTTP/WebSocket server. Give each profile on a machine its own. |

### State on disk

| Variable | Default | What it does |
|---|---|---|
| `RELAY_SESSIONS_FILE` | per-profile path | Where session and tab state is persisted across restarts. |
| `RELAY_BACKGROUND_JOBS_FILE` | per-profile path | Where background-job state is persisted. |
| `RELAY_UPLOAD_DIR` | a temporary directory | Where files sent from the client (pasted images and the like) are written. |
| `RELAY_SHUTDOWN_GRACE_MS` | `240000` (4 minutes) | How long a restart or shutdown waits for in-flight turns to finish before forcing them closed. |

### Open in editor

The file panel's "open in editor" action is hidden unless one of these is
set. Locality is declared here rather than inferred from the connecting
peer's address, because the address genuinely doesn't settle the question: a
loopback peer can be this machine or a tunnel terminating on it, and a
tailnet-IP peer can still be this same physical box.

| Variable | What it does |
|---|---|
| `ANYWH_EDITOR_LOCAL` | Set to `1` when clients connect to this relay *from this same machine*. Opens paths with a local deep link (`zed://file…`, `vscode://file…`). Honored only when the request's peer address really is this machine. |
| `ANYWH_EDITOR_SSH` | Set to an SSH target when clients connect *from a different machine* — the client dials it from its own end using the editor's SSH-remote deep link. Anything `ssh` accepts works, including a `~/.ssh/config` alias, which is usually the least friction. `user@host` or `user@host:2222`. |

## Installer

Read by `install-relay.sh` (and by the app's own *Set up on this machine*, which
runs the same script). None is needed for a normal install.

| Variable | Default | What it does |
|---|---|---|
| `ANYWH_INSTALL_DIR` | `~/.local/share/anywh` | Where the relay tree is unpacked. |
| `ANYWH_ENV_DIR` | `~/.config/anywh/env` | Where per-profile `.env` files go — mirrors the relay's own `ANYWH_ENV_DIR`. |
| `AGENT_BIN` / `CLAUDE_BIN` | `claude` | The agent CLI whose presence and login are checked — the same resolution the relay uses. |
| `ANYWH_SKIP_AGENT_LOGIN_CHECK` | — | Set to `1` to skip running `auth status --json` — for a box where the login happens later, or a CLI without that command. |
| `ANYWH_RELEASE_BASE_URL` | GitHub's release downloads | Where the tarball and `SHA256SUMS` are fetched from — a mirror, or a locally served build. |
| `ANYWH_INSTALL_SCRIPT` | the embedded script | App only: a path to run instead of the `install-relay.sh` embedded in the binary. For development and the e2e stub. |

## Client

The client has no build-time configuration. Which relay it talks to is a
*profile* — created on the first-run screen (connect to a machine by address
and port, or paste a pairing code), or added later from the profile switcher
— and stored on the device. On desktop the stored list can also be edited
from DevTools; see
[Self-hosting](./self-hosting.md#pointing-the-client-at-your-relay).
