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
source "$SCRIPT_DIR/../lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") <id> [options]

  --label <text>       Display label (default: <id>)
  --home <path>        Overridden \$HOME for this profile's claude account
                        (default: the real \$HOME, i.e. no isolation)
  --port <port>        Relay port (default: first free port found)
  --relay-host <ip>    Host this profile's relay binds/advertises on
                        (default: read from an existing profile's .env)
  --mode dev|prod      dev prints the run command; prod enables the
                        systemd instance (default: prod)
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
PORT=""
RELAY_HOST_ARG=""
MODE="prod"
RESUME=0
PORCELAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --home) PROFILE_HOME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --relay-host) RELAY_HOST_ARG="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --porcelain) PORCELAIN=1; shift ;;
    *) echo "error: unknown argument '$1'" >&2; usage ;;
  esac
done

# Same vocabulary as the top-level install.sh's --porcelain: one `ANYWH`
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
    esac
  done < "$ENV_FILE"
fi

LABEL="${LABEL:-$ID}"

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
  if [[ "${#mismatches[@]}" -gt 0 ]]; then
    printf 'error: %s differs from what this run would write:\n' "$ENV_FILE" >&2
    printf '  %s\n' "${mismatches[@]}" >&2
    porcelain "fail profile resume_mismatch $ENV_FILE differs: ${mismatches[*]}"
    exit 1
  fi
  echo "Resuming $ENV_FILE"
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
  # buildChildEnv's `if (homeOverride)` check (claudeSession.ts).
  if [[ -n "$PROFILE_HOME" && "$PROFILE_HOME" != "$HOME" ]]; then
    echo "RELAY_HOME_OVERRIDE=$PROFILE_HOME"
  fi
  echo "RELAY_UPLOAD_DIR=/tmp/anywh-uploads-$ID"
  echo "RELAY_SESSIONS_FILE=$HOME/.anywh-sessions/$ID.json"
  echo "RELAY_BACKGROUND_JOBS_FILE=$HOME/.anywh-sessions/$ID-bg-jobs.json"
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
} > "$ENV_TMP"
mv "$ENV_TMP" "$ENV_FILE"

# `profiles.json` read-modify-write done in Node (already a hard
# requirement for the relay itself) rather than hand-rolled in bash —
# allocates the smallest colorIndex not already taken, same rule as
# `profileColorClass` uses for profiles that predate the field.
PROFILES_JSON="$(dirname "$ANYWH_ENV_DIR")/profiles.json"
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
  id,
  label,
  colorIndex: existing ? existing.colorIndex : colorIndex,
  createdAt: existing ? existing.createdAt : now,
  updatedAt: now,
};
data.profiles = [...data.profiles.filter((p) => p.id !== id), entry];
fs.writeFileSync(path, JSON.stringify(data, null, 2));
' "$PROFILES_JSON" "$ID" "$LABEL"

echo "Provisioned $ENV_FILE"

# Only a source checkout has this: the Linux tarball ships relay/ next to
# infra/ (install.sh's own layout), but the macOS Homebrew build ships a
# single SEA binary instead (relay/sea-build/build.mjs) with no relay/
# directory at all. app-install.sh still passes --mode dev here — it has
# no launchd unit for this script to enable, same reason a Linux box
# without a user systemd session does — so this branch runs on both, and
# unconditionally `cd`-ing into a relay/ that doesn't exist used to take
# `set -e` down with it, right after the profile had already been written.
if [[ "$MODE" == "dev" && -d "$SCRIPT_DIR/../../relay" ]]; then
  RELAY_DIR="$(cd "$SCRIPT_DIR/../../relay" && pwd)"
  cat <<EOF

Run it in dev mode with:
  cd "$RELAY_DIR" && ANYWH_PROFILE=$ID npm run dev:profile
EOF
elif [[ "$MODE" == "dev" ]]; then
  : # macOS: brew services start anywh-relay is the actual next step,
    # already covered by the formula's own caveats.
elif systemctl --user is-active --quiet "anywh-relay@$ID"; then
  # Already up from an earlier run — `enable --now` on a running instance is
  # harmless to systemd but a re-run of the installer must not be the thing
  # that restarts a relay with a conversation in flight.
  echo "anywh-relay@$ID is already running; left as is"
else
  systemctl --user enable --now "anywh-relay@$ID"
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
