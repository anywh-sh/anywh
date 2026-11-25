#!/usr/bin/env bash
# Provisions a new relay profile: writes the profile's `.env`,
# records it in `profiles.json`, and (in --mode prod) enables the systemd
# instance. Counterpart to install.sh, which provisions the shared unit
# template once per machine — this runs once per profile.
#
# `--mode prod`'s `systemctl --user enable --now` only works once the unit
# template is user-scope — running it before that lands
# fails for lack of a user session (no XDG_RUNTIME_DIR/DBus). Use
# `--mode dev` until then.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The relay's tests point this at a fake (SYSTEMCTL_BIN, as for the relay's
# own spawns): a real `systemctl --user` reaches the operator's live units.
SYSTEMCTL="${SYSTEMCTL_BIN:-systemctl}"
# Same for `launchctl`, which reaches the user's real launchd session.
LAUNCHCTL="${LAUNCHCTL_BIN:-launchctl}"
source "$SCRIPT_DIR/../lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") <id> [options]

  --label <text>       Display label (default: <id>)
  --home <path>        Overridden \$HOME for this profile's claude account
                        (default: the real \$HOME, i.e. no isolation)
  --config-root <path> Keep the real \$HOME and give each agent CLI its own
                        config folder under <path> (claude/, codex/, kimi/,
                        plus rooms/) — its own account for each. Excludes
                        --home
  --env KEY=VALUE      One more line for the profile's .env (repeatable),
                        kept across --resume like any key this script
                        doesn't otherwise write
  --port <port>        Relay port (default: first free port found)
  --relay-host <ip>    Host this profile's relay binds/advertises on
                        (default: read from an existing profile's .env)
  --mode dev|prod      dev prints the run command; prod enables the
                        systemd instance, or for the macOS app's relay
                        (ANYWH_RELAY_MANAGED_BY_APP=1) starts its launchd
                        jobs (default: prod)
  --resume             Accept an existing <id>.env if it matches what this
                        invocation would write (or is incomplete), and
                        finish whatever was left undone — instead of
                        refusing because the file exists
  --porcelain          Print a machine-readable "ANYWH profile ..." line
EOF
  # $1: exit code — 0 for an explicit --help, 1 for a usage error, so
  # scripting against this doesn't see "help was shown" as a failure.
  exit "${1:-1}"
}

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage "$([[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && echo 0 || echo 1)"
fi
ID="$1"
shift

LABEL=""
PROFILE_HOME=""
CONFIG_ROOT=""
EXTRA_ENV=()
PORT=""
RELAY_HOST_ARG=""
MODE="prod"
RESUME=0
PORCELAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --home) PROFILE_HOME="$2"; shift 2 ;;
    --config-root) CONFIG_ROOT="$2"; shift 2 ;;
    --env)
      if [[ ! "$2" =~ ^[A-Z_][A-Z0-9_]*=.*$ ]]; then echo "error: --env takes KEY=VALUE, got '$2'" >&2; exit 1; fi
      EXTRA_ENV+=("$2"); shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --relay-host) RELAY_HOST_ARG="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --porcelain) PORCELAIN=1; shift ;;
    *) echo "error: unknown argument '$1'" >&2; usage ;;
  esac
done

# Same vocabulary as the top-level install-relay.sh's --porcelain: one `ANYWH`
# line the caller can parse. Only ever printed when asked, so the human
# output is unchanged.
porcelain() {
  if [[ "$PORCELAIN" -eq 1 ]]; then echo "ANYWH $*"; fi
}

# fail <code> <message...> — one line on stderr for the human, one
# `ANYWH fail profile <code>` for the program, then exit 1.
fail() {
  local code="$1"
  shift
  echo "error: $*" >&2
  porcelain "fail profile $code $*"
  exit 1
}

if [[ ! "$ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: invalid profile id '$ID' (expected ^[a-z0-9][a-z0-9-]*\$)" >&2
  exit 1
fi
if [[ -n "$PROFILE_HOME" && -n "$CONFIG_ROOT" ]]; then
  echo "error: --home and --config-root are two ways to isolate an account; pass one" >&2
  exit 1
fi
if [[ "$MODE" != "dev" && "$MODE" != "prod" ]]; then
  echo "error: --mode must be 'dev' or 'prod'" >&2
  exit 1
fi

ENV_FILE="$ANYWH_ENV_DIR/$ID.env"
# What a previous run left behind, if anything. Without --resume an existing
# file is a hard stop, as it always was — the control API's own
# `POST /control/profiles` relies on that to never clobber a profile. With
# it, the file is read and compared against what this run would write:
# a match (or a file missing keys, i.e. a write that died halfway) is
# resumed, a real difference is listed and refused.
# Plain variables, not an associative array: macOS ships bash 3.2, which
# has no associative arrays, and this script runs there too (dev mode).
EXISTING_FILE=0
EXISTING_PORT=""
EXISTING_HOST=""
EXISTING_HOME=""
EXISTING_CLAUDE_DIR=""
# Lines of keys this script doesn't write (an operator's own
# ANYWH_EDITOR_SSH, say). Kept as they are on --resume: the file is rewritten
# whole, and dropping them silently changed the profile — losing a config
# dir would have turned it into the real $HOME's account.
EXTRA_LINES=""
MANAGED_KEYS=" RELAY_PORT RELAY_HOST RELAY_HOME_OVERRIDE RELAY_UPLOAD_DIR RELAY_SESSIONS_FILE RELAY_BACKGROUND_JOBS_FILE RELAY_WAKEUPS_FILE RELAY_PUSH_DEVICES_FILE ANYWH_EDITOR_LOCAL "
CONFIG_ROOT_KEYS=" CLAUDE_CONFIG_DIR CODEX_HOME KIMI_CODE_HOME RELAY_DATA_DIR "
if [[ -e "$ENV_FILE" ]]; then
  if [[ "$RESUME" -eq 0 ]]; then
    fail exists "profile '$ID' already exists ($ENV_FILE)"
  fi
  EXISTING_FILE=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    case "${line%%=*}" in
      RELAY_PORT) EXISTING_PORT="${line#*=}" ;;
      RELAY_HOST) EXISTING_HOST="${line#*=}" ;;
      RELAY_HOME_OVERRIDE) EXISTING_HOME="${line#*=}" ;;
      CLAUDE_CONFIG_DIR) EXISTING_CLAUDE_DIR="${line#*=}" ;;
    esac
    key="${line%%=*}"
    # A key given again with --env takes the new value, written below.
    for pair in "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}"; do
      if [[ "${pair%%=*}" == "$key" ]]; then continue 2; fi
    done
    if [[ "$MANAGED_KEYS" != *" $key "* ]]; then
      # A config-root key is only this script's while --config-root says
      # so; otherwise it is the operator's and kept like any other.
      if [[ -n "$CONFIG_ROOT" && "$CONFIG_ROOT_KEYS" == *" $key "* ]]; then continue; fi
      EXTRA_LINES+="$line"$'\n'
    fi
  done < "$ENV_FILE"
fi

# No default label here: the registry write below keeps an existing
# profile's own label when none is given, and names a new one after its id.

# Same host as this machine's other profiles, if any — every profile on one
# machine reaches the outside world the same way. Omitting this defaults
# the relay to loopback (server.ts's own fallback), unreachable from
# another device even though it's running fine — the most confusing failure
# mode confirmed in practice, because nothing looks wrong
# locally. Two things this fallback refuses to do: inherit a loopback
# address (a stray `npm run dev` self-registers a `default.env` with
# `RELAY_HOST=127.0.0.1`, and that used to become the host of every profile
# created after it), and pick between profiles that disagree — glob order
# is not a decision.
RELAY_HOST="$RELAY_HOST_ARG"
if [[ -z "$RELAY_HOST" && -n "$EXISTING_HOST" ]]; then
  RELAY_HOST="$EXISTING_HOST"
fi
if [[ -z "$RELAY_HOST" ]]; then
  candidates="$(
    for f in "$ANYWH_ENV_DIR"/*.env; do
      [[ -e "$f" && "$f" != "$ENV_FILE" ]] || continue
      grep -h '^RELAY_HOST=' "$f" 2>/dev/null | cut -d= -f2- || true
    done | grep -vE '^(127\.[0-9.]+|localhost|::1)$' | sort -u
  )"
  if [[ "$(wc -l <<<"$candidates")" -gt 1 && -n "$candidates" ]]; then
    fail relay_host_ambiguous "--relay-host is required: the existing profiles disagree on theirs ($(tr '\n' ' ' <<<"$candidates"| sed 's/ $//'))"
  fi
  RELAY_HOST="$candidates"
fi
if [[ -z "$RELAY_HOST" ]]; then
  fail relay_host_required "--relay-host is required (no existing profile to read a default from)"
fi

# Bash's own /dev/tcp, not a bind test: good enough for a script an operator
# runs occasionally, unlike the relay's own `allocatePort`
# (profileRegistry.ts) which also test-binds because it has to be race-safe
# against `POST /control/profiles` calls.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

allocate_port() {
  local claimed
  claimed="$(grep -h '^RELAY_PORT=' "$ANYWH_ENV_DIR"/*.env 2>/dev/null | cut -d= -f2- || true)"
  local port
  for ((port = 8765; port < 8865; port++)); do
    if grep -qx "$port" <<<"$claimed"; then
      continue
    fi
    if port_in_use "$port"; then
      continue
    fi
    echo "$port"
    return 0
  done
  echo "error: no free relay port in 8765-8865" >&2
  return 1
}

# A resumed profile keeps the port it already has: the unit may already be
# enabled on it, and a device that verified it once dials that number.
if [[ -z "$PORT" && -n "$EXISTING_PORT" ]]; then
  PORT="$EXISTING_PORT"
fi
if [[ -z "$PORT" ]]; then
  PORT="$(allocate_port)"
fi

if [[ -n "$PROFILE_HOME" ]]; then
  # Absolute, `~` expanded, and created if new (the account's `claude
  # login` needs a real directory to write credentials into before this
  # profile can ever pass validation) — a relative or `~`-prefixed path in
  # the .env would be interpreted relative to whatever cwd/$HOME the
  # *relay* process happens to have, not this shell's.
  PROFILE_HOME="${PROFILE_HOME/#\~/$HOME}"
  mkdir -p "$PROFILE_HOME"
  PROFILE_HOME="$(cd "$PROFILE_HOME" && pwd)"
fi

if [[ -n "$CONFIG_ROOT" ]]; then
  # Same rules as --home: absolute, `~` expanded. Resolved here but only
  # created after the --resume check below: a refused run must not leave a
  # folder behind that the relay would then take for a draft.
  CONFIG_ROOT="${CONFIG_ROOT/#\~/$HOME}"
  [[ "$CONFIG_ROOT" == /* ]] || CONFIG_ROOT="$PWD/$CONFIG_ROOT"
  if [[ -d "$CONFIG_ROOT" ]]; then CONFIG_ROOT="$(cd "$CONFIG_ROOT" && pwd)"; fi
fi

# The comparison --resume promises. Only keys that are present in the file
# and differ count as divergence — an absent key is a write that died
# before reaching it, which is what resuming is for. Listed all at once so
# the human sees the whole disagreement, not the first line of it.
if [[ "$EXISTING_FILE" -eq 1 ]]; then
  want_home=""
  if [[ -n "$PROFILE_HOME" && "$PROFILE_HOME" != "$HOME" ]]; then want_home="$PROFILE_HOME"; fi
  mismatches=()
  [[ -z "$EXISTING_PORT" || "$EXISTING_PORT" == "$PORT" ]] || mismatches+=("RELAY_PORT: have $EXISTING_PORT, want $PORT")
  [[ -z "$EXISTING_HOST" || "$EXISTING_HOST" == "$RELAY_HOST" ]] || mismatches+=("RELAY_HOST: have $EXISTING_HOST, want $RELAY_HOST")
  [[ -z "$EXISTING_HOME" || "$EXISTING_HOME" == "$want_home" ]] || mismatches+=("RELAY_HOME_OVERRIDE: have $EXISTING_HOME, want ${want_home:-<none>}")
  if [[ -n "$CONFIG_ROOT" ]]; then
    [[ -z "$EXISTING_CLAUDE_DIR" || "$EXISTING_CLAUDE_DIR" == "$CONFIG_ROOT/claude" ]] || mismatches+=("CLAUDE_CONFIG_DIR: have $EXISTING_CLAUDE_DIR, want $CONFIG_ROOT/claude")
  fi
  if [[ "${#mismatches[@]}" -gt 0 ]]; then
    printf 'error: %s differs from what this run would write:\n' "$ENV_FILE" >&2
    printf '  %s\n' "${mismatches[@]}" >&2
    porcelain "fail profile resume_mismatch $ENV_FILE differs: ${mismatches[*]}"
    exit 1
  fi
  echo "Resuming $ENV_FILE"
fi

if [[ -n "$CONFIG_ROOT" ]]; then
  # Created now when the relay didn't already (a draft): the agent login
  # that has to pass before this profile is created writes into it. 0700:
  # it holds the profile's agent credentials.
  mkdir -p "$CONFIG_ROOT"
  CONFIG_ROOT="$(cd "$CONFIG_ROOT" && pwd)"
  for sub in claude codex kimi rooms bots; do mkdir -p "$CONFIG_ROOT/$sub"; done
  chmod 700 "$CONFIG_ROOT"
fi

mkdir -p "$ANYWH_ENV_DIR"
mkdir -p "$HOME/.anywh-sessions"

# Written to a sibling and renamed into place: `{ ... } > "$ENV_FILE"`
# truncated the file first and filled it line by line, so a death in the
# middle left a real-looking .env without RELAY_PORT — which the relay's
# parseEnvFile reads as a profile with no port, and which this script
# refused to touch again because "it exists".
ENV_TMP="$ENV_FILE.tmp.$$"
trap 'rm -f "$ENV_TMP"' EXIT
{
  echo "RELAY_PORT=$PORT"
  echo "RELAY_HOST=$RELAY_HOST"
  # Omitted entirely for the real $HOME: EnvironmentFile has no way to
  # express "unset a variable", and an empty value would still be truthy in
  # buildChildEnv's `if (homeOverride)` check (runtimes/defs/claude/session.ts).
  if [[ -n "$PROFILE_HOME" && "$PROFILE_HOME" != "$HOME" ]]; then
    echo "RELAY_HOME_OVERRIDE=$PROFILE_HOME"
  fi
  echo "RELAY_UPLOAD_DIR=/tmp/anywh-uploads-$ID"
  echo "RELAY_SESSIONS_FILE=$HOME/.anywh-sessions/$ID.json"
  echo "RELAY_BACKGROUND_JOBS_FILE=$HOME/.anywh-sessions/$ID-bg-jobs.json"
  echo "RELAY_WAKEUPS_FILE=$HOME/.anywh-sessions/$ID-wakeups.json"
  echo "RELAY_PUSH_DEVICES_FILE=$HOME/.anywh-sessions/$ID-push-devices.json"
  # "Open in editor" on by default for every profile this
  # script provisions — safe because editorHostInfo.ts's peer check only
  # ever downgrades this to ssh/null for a client connecting from a
  # different machine, never promotes it; it can't leak "local" to a
  # remote client. Remove this line (or set it to anything other than "1")
  # to opt out. A managed-hosting deployment never runs this script — its
  # own image build pre-seeds this same variable explicitly empty, a
  # completely separate mechanism, so this default has no
  # effect on that path.
  echo "ANYWH_EDITOR_LOCAL=1"
  if [[ -n "$CONFIG_ROOT" ]]; then
    # Absolute paths: EnvironmentFile expands neither `~` nor $HOME.
    echo "CLAUDE_CONFIG_DIR=$CONFIG_ROOT/claude"
    echo "CODEX_HOME=$CONFIG_ROOT/codex"
    echo "KIMI_CODE_HOME=$CONFIG_ROOT/kimi"
    # Its own data root, where the relay keeps its rooms' and bots' folders
    # (relay/src/host/paths.ts): every profile on the real $HOME would
    # otherwise share ~/.anywh, and each relay prunes the room folders it
    # doesn't know — the other profiles' included.
    echo "RELAY_DATA_DIR=$CONFIG_ROOT"
  fi
  printf '%s' "$EXTRA_LINES"
  for pair in "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}"; do echo "$pair"; done
} > "$ENV_TMP"
mv "$ENV_TMP" "$ENV_FILE"

# `profiles.json` read-modify-write done in Node rather than hand-rolled in
# bash — allocates the smallest colorIndex not already taken, same rule as
# `profileColorClass` uses for profiles that predate the field. Inside the
# macOS SEA tree (the binary two levels up) there may be no `node` to run:
# the binary does the same write itself (relay/src/host/recordProfile.ts,
# which must stay in sync with the snippet below). Everywhere else Node is
# already a hard requirement of the relay.
PROFILES_JSON="$(dirname "$ANYWH_ENV_DIR")/profiles.json"
SEA_BIN="$SCRIPT_DIR/../../anywh-relay"
if [[ -x "$SEA_BIN" ]]; then
  "$SEA_BIN" record-profile "$PROFILES_JSON" "$ID" "$LABEL"
else
node -e '
const fs = require("fs");
// `-e` doesn'\''t consume an argv slot for a script filename the way a real
// script file would, so the first CLI arg is argv[1], not argv[2].
const [, path, id, label] = process.argv;
let data = { version: 1, profiles: [] };
if (fs.existsSync(path)) {
  try {
    data = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    // Falls back to an empty registry — a corrupt profiles.json shouldn'\''t
    // block provisioning a new profile.
  }
}
if (!Array.isArray(data.profiles)) data.profiles = [];

const used = new Set(data.profiles.map((p) => p.colorIndex).filter((i) => typeof i === "number"));
let colorIndex = 0;
while (used.has(colorIndex)) colorIndex++;

const now = new Date().toISOString();
const existing = data.profiles.find((p) => p.id === id);
const entry = {
  ...existing,
  id,
  label: label || (existing && existing.label) || id,
  colorIndex: existing ? existing.colorIndex : colorIndex,
  createdAt: existing ? existing.createdAt : now,
  updatedAt: now,
};
data.profiles = [...data.profiles.filter((p) => p.id !== id), entry];
fs.writeFileSync(path, JSON.stringify(data, null, 2));
' "$PROFILES_JSON" "$ID" "$LABEL"
fi

echo "Provisioned $ENV_FILE"

# Only a source checkout has this: the Linux tarball ships relay/ next to
# infra/ (install-relay.sh's own layout), but the macOS Homebrew build ships a
# single SEA binary instead (relay/sea-build/build.mjs) with no relay/
# directory at all. app-install.sh still passes --mode dev here — it has
# no launchd unit for this script to enable, same reason a Linux box
# without a user systemd session does — so this branch runs on both, and
# unconditionally `cd`-ing into a relay/ that doesn't exist used to take
# `set -e` down with it, right after the profile had already been written.
# The profile's agent host (anywh-agent-host@<id>): keeps agent processes
# alive across relay restarts. Only enabled when its unit is installed —
# install.sh renders it, and a machine provisioned before it existed keeps
# working without one. Never restarted here: restarting it ends every
# agent's process (idle ones are hibernated, turns in flight are cut).
enable_agent_host() {
  if [[ ! -f "$HOME/.config/systemd/user/anywh-agent-host@.service" ]]; then
    echo "note: the anywh-agent-host@ unit isn't installed (re-run infra/systemd/install.sh); skipping anywh-agent-host@$ID"
    return 0
  fi
  if "$SYSTEMCTL" --user is-active --quiet "anywh-agent-host@$ID"; then
    echo "anywh-agent-host@$ID is already running; left as is"
  elif "$SYSTEMCTL" --user enable --now "anywh-agent-host@$ID"; then
    echo "Enabled anywh-agent-host@$ID (check: systemctl --user status anywh-agent-host@$ID)"
  else
    # Not fatal (`set -e` must not stop here): the relay works without its
    # agent host; only what runs agents through the host is unavailable.
    echo "warning: couldn't enable anywh-agent-host@$ID — the relay still works; check 'systemctl --user status anywh-agent-host@$ID'" >&2
  fi
}

# The macOS app's relay (ANYWH_RELAY_MANAGED_BY_APP, set by the app and by
# the relay's own launchd jobs): this script sits in the relay tree the app
# copied to Application Support, and each local profile is two launchd jobs,
# the counterparts of anywh-relay@ and anywh-agent-host@. Their plists live
# beside the tree, not in ~/Library/LaunchAgents: launchd knows them only
# until logout, so nothing starts at login (the app bootstraps them again
# when it is opened) and macOS adds no login item for them.
xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

# write_plist <path> <label> <log file> <exit timeout> <program args...>
write_plist() {
  local path="$1" label="$2" log="$3" exit_timeout="$4"
  shift 4
  local arg
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
EOF
    for arg in "$@"; do echo "    <string>$(xml_escape "$arg")</string>"; done
    cat <<EOF
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_ENV_FILE</key>
    <string>$(xml_escape "$ENV_FILE")</string>
    <key>ANYWH_ENV_DIR</key>
    <string>$(xml_escape "$ANYWH_ENV_DIR")</string>
    <key>ANYWH_PROFILE</key>
    <string>$ID</string>
    <key>ANYWH_RESTART_ON_UPDATE</key>
    <string>1</string>
    <key>ANYWH_RELAY_MANAGED_BY_APP</key>
    <string>1</string>
    <key>ANYWH_LAUNCHD_DIR</key>
    <string>$(xml_escape "$LAUNCHD_DIR")</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME/.anywh-sessions")</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ExitTimeOut</key>
  <integer>$exit_timeout</integer>
</dict>
</plist>
EOF
  } > "$path.tmp.$$"
  mv "$path.tmp.$$" "$path"
}

# bootstrap_job <label> <plist>: loads it unless it already is. Like the
# systemd branch's "already running; left as is", a re-run must not be what
# restarts a relay with a conversation in flight.
bootstrap_job() {
  local label="$1" plist="$2"
  if "$LAUNCHCTL" print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    echo "$label is already running; left as is"
  elif "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$plist"; then
    echo "Started $label"
  else
    fail launchd "couldn't start $label (launchctl bootstrap gui/$(id -u) $plist)"
  fi
}

if [[ "$MODE" == "prod" && "${ANYWH_RELAY_MANAGED_BY_APP:-}" == "1" ]]; then
  TREE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  LAUNCHD_DIR="${ANYWH_LAUNCHD_DIR:-$(dirname "$TREE_DIR")/launchd}"
  mkdir -p "$LAUNCHD_DIR"
  LAUNCHD_DIR="$(cd "$LAUNCHD_DIR" && pwd)"
  RELAY_LABEL="sh.anywh.relay.$ID"
  HOST_LABEL="sh.anywh.agent-host.$ID"
  # Exit timeouts match the systemd units' TimeoutStopSec: the relay drains
  # its turns, the host its agents, before launchd may SIGKILL them.
  write_plist "$LAUNCHD_DIR/$HOST_LABEL.plist" "$HOST_LABEL" "$HOME/.anywh-sessions/$ID-agent-host.log" 75 \
    "$TREE_DIR/anywh-relay" agent-host --profile "$ID"
  write_plist "$LAUNCHD_DIR/$RELAY_LABEL.plist" "$RELAY_LABEL" "$HOME/.anywh-sessions/$ID-relay.log" 300 \
    "$TREE_DIR/anywh-relay"
  bootstrap_job "$HOST_LABEL" "$LAUNCHD_DIR/$HOST_LABEL.plist"
  bootstrap_job "$RELAY_LABEL" "$LAUNCHD_DIR/$RELAY_LABEL.plist"
  if wait_for_relay "$RELAY_HOST" "$PORT"; then
    echo "$RELAY_LABEL is answering on $RELAY_HOST:$PORT"
  else
    echo "warning: $RELAY_LABEL didn't answer on $RELAY_HOST:$PORT yet; check $HOME/.anywh-sessions/$ID-relay.log" >&2
  fi
elif [[ "$MODE" == "dev" && -d "$SCRIPT_DIR/../../relay" ]]; then
  RELAY_DIR="$(cd "$SCRIPT_DIR/../../relay" && pwd)"
  cat <<EOF

Run it in dev mode with:
  cd "$RELAY_DIR" && ANYWH_PROFILE=$ID npm run dev:profile
and, in another shell, its agent host:
  cd "$RELAY_DIR" && ANYWH_PROFILE=$ID npm run dev:agent-host:profile
EOF
elif [[ "$MODE" == "dev" ]]; then
  : # macOS: brew services start anywh-relay is the actual next step,
    # already covered by the formula's own caveats.
elif "$SYSTEMCTL" --user is-active --quiet "anywh-relay@$ID"; then
  # Already up from an earlier run — `enable --now` on a running instance is
  # harmless to systemd but a re-run of the installer must not be the thing
  # that restarts a relay with a conversation in flight.
  echo "anywh-relay@$ID is already running; left as is"
  enable_agent_host
else
  enable_agent_host
  "$SYSTEMCTL" --user enable --now "anywh-relay@$ID"
  echo "Enabled anywh-relay@$ID (check: systemctl --user status anywh-relay@$ID)"
  # `enable --now` returns once systemd has forked the unit, not once the
  # relay has bound its port — see wait_for_relay (infra/lib.sh) for why
  # that difference is the whole point of waiting here.
  if wait_for_relay "$RELAY_HOST" "$PORT"; then
    echo "anywh-relay@$ID is answering on $RELAY_HOST:$PORT"
  else
    echo "warning: anywh-relay@$ID didn't answer on $RELAY_HOST:$PORT yet — check 'systemctl --user status anywh-relay@$ID'" >&2
  fi
fi

porcelain "profile id=$ID port=$PORT host=$RELAY_HOST mode=$MODE env=$ENV_FILE"
