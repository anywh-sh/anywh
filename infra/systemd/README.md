# Running the relay as a systemd service

This is the "advanced" self-host path — a persistent service that survives
reboots and restarts on crash. It's optional: `npm start` from an
interactive shell (see the root README) works fine for a single machine you
keep an eye on yourself. Reach for this when you want the relay to come
back on its own after a reboot or a crash, with no one watching.

## One template, any number of profiles

`anywh-relay@.service.template` is a systemd
[instantiated unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#Specifiers) —
one file serves every profile you run (`pessoal`, `trabalho`, `default`,
whatever you call them), each as its own systemd instance
(`anywh-relay@<profile>`). It's a user-scope unit (`systemctl --user`, no
sudo) — running as *your* user was always the intent, since the relay only
ever needed to run as whoever owns the Claude Code login it's isolating, not
as root. It isn't committed with real paths in it: the relay's absolute
directory and the absolute `node` binary path are specific to the machine it
runs on, so `install.sh` fills those in and writes the rendered
`anywh-relay@.service` next to the template (gitignored — it's a build
artifact, regenerate it whenever paths change).

Profile-specific config (`RELAY_PORT`, `RELAY_HOME_OVERRIDE`, ...) doesn't
live in the unit at all — it comes from two `EnvironmentFile`s, loaded in
order so the second wins on conflicts:

1. `relay/.env` — shared across every profile (`AGENT_BIN`,
   `EXTRA_PATH_DIRS`, anything that doesn't vary by profile).
2. `~/.config/anywh/env/<profile>.env` — per-profile overrides.

Both are optional (`EnvironmentFile=-...`), so a single-profile setup can
skip the second file, or even both, and run on the relay's own defaults.

## Setup

```bash
./install.sh                          # renders anywh-relay@.service for this machine
mkdir -p ~/.config/systemd/user
cp anywh-relay@.service ~/.config/systemd/user/
systemctl --user daemon-reload

# Once per machine — a user-scope unit stops the moment your last login
# session ends unless linger is on, which defeats the point on a headless
# box with no one logged in most of the time.
loginctl enable-linger "$(whoami)"

cd ../../relay
npm install && npm run build
cp .env.example .env                  # edit AGENT_BIN/EXTRA_PATH_DIRS etc. if needed

systemctl --user enable --now anywh-relay@default
```

For more than one profile, give each its own env file before enabling it:

```bash
mkdir -p ~/.config/anywh/env
cat > ~/.config/anywh/env/pessoal.env <<'EOF'
RELAY_PORT=8765
RELAY_SESSIONS_FILE=/home/you/.anywh-sessions/pessoal.json
RELAY_BACKGROUND_JOBS_FILE=/home/you/.anywh-sessions/pessoal-bg-jobs.json
RELAY_UPLOAD_DIR=/tmp/anywh-uploads-pessoal
ANYWH_EDITOR_LOCAL=1
EOF
systemctl --user enable --now anywh-relay@pessoal
```

Or use `add-profile.sh` (same directory) to generate the `.env` and enable
the instance in one step — see its `--help` output. This is the same script
the client's own **Adicionar perfil** → **Criar** dialog calls behind the
scenes (root README's "Profiles" section) — reach for it directly only when
scripting a setup or working before the app is even connected.

Repeat with a second file (different port, paths, and — if it's a fully
separate Claude Code login — `RELAY_HOME_OVERRIDE`) for a second profile.

## The agent host (`anywh-agent-host@<profile>`)

`anywh-agent-host@.service.template` is the relay's sibling: one per
profile, rendered and installed by the same `install.sh`, enabled by
`add-profile.sh` next to the relay. It owns long-lived agent processes (one
`claude` per agent, each in its own process group) and talks to the relay
over a unix socket, so restarting or upgrading `anywh-relay@<profile>`
leaves every agent — and any turn in flight — running. The relay reconnects
and replays what it missed from each agent's log.

- Same env files as the relay (`relay/.env`, then `<profile>.env`). The host
  gets its profile as an argument (`--profile %i`), never from the
  environment; the relay's unit sets `ANYWH_PROFILE=%i`, which the relay does
  not pass on to anything it spawns. Both derive the socket path from the
  profile (`$XDG_RUNTIME_DIR/anywh/agent-host-<profile>.sock`) unless
  `ANYWH_AGENT_HOST_SOCKET` says otherwise. For development,
  `npm run dev:agent-host` runs a host for a separate `dev` profile;
  `ANYWH_PROFILE=<id> npm run dev:agent-host:profile` targets a real one,
  on purpose. Data (registry, per-agent logs)
  lives in `~/.anywh-sessions/<profile>-agent-host/` unless
  `ANYWH_AGENT_HOST_DIR` says otherwise. A user unit does not inherit your
  shell's `PATH`: `AGENT_BIN`/`EXTRA_PATH_DIRS` in the env files are how it
  finds the agent CLI and the tools agents run.
- It is not `PartOf=`/`BindsTo=` the relay on purpose, and
  `restart-profiles.sh` does not touch it. Restart it only when needed (an
  upgrade that changed the relay↔host protocol: a relay that meets a host
  from another release is refused explicitly and logs both releases).
  Stopping it drains: turns in flight get `ANYWH_AGENT_HOST_DRAIN_GRACE_MS`
  (2 min) to finish, then are interrupted; idle agents are hibernated and
  resume transparently later; agents whose work was cut come back
  "stopped", resumable. A crash or `SIGKILL` brings every agent back
  stopped and resumable — never running on its own.
- Hibernation (ending an idle agent's process, keeping its session):
  `ANYWH_AGENT_HOST_HIBERNATE=idle` (default; after
  `ANYWH_AGENT_HOST_IDLE_MS`, 10 min), `memory` (only while agents use more
  than `ANYWH_AGENT_HOST_MEMORY_FRACTION` (0.6) of
  `ANYWH_AGENT_HOST_MEMORY_BYTES`, default the machine's RAM) or `off`. At
  most `ANYWH_AGENT_HOST_MAX_ALIVE_PER_ROOM` (10) live agents per room.

```bash
systemctl --user status anywh-agent-host@default
journalctl --user -u anywh-agent-host@default -f
curl -s http://127.0.0.1:8765/agents/activity   # through the relay
```

Not covered yet: macOS (`launchd`/Homebrew ships the relay only).

## Checking it

```bash
systemctl --user status anywh-relay@default
journalctl --user -u anywh-relay@default -f
```

## Remote access

The systemd service binds wherever `RELAY_HOST` says (defaults to
`127.0.0.1`, i.e. clients on the same machine only). For access from another
device, see "Remote access" in the root README.
