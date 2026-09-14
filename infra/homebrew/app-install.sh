#!/usr/bin/env bash
# Installs the relay on this Mac by driving the exact commands
# homebrew-tap/README.md and the landing page document for a human to type
# by hand — brew install, provision the "default" profile, start the
# launchd service — one after another, with the same "ANYWH ..." porcelain
# protocol install.sh emits, so the app's relay-setup wizard drives this
# the same way it drives that one.
#
# Homebrew's service DSL has no per-profile template like systemd's
# anywh-relay@.service (see the formula's own comment above its `service
# do` block), so this — like the formula's caveats — only ever provisions
# a profile named "default". A machine with an existing non-default relay
# has nothing to gain from this script; the app's own probe sends it to
# the adopt screen instead of here.
set -euo pipefail

PORCELAIN=0
RELAY_HOST=""
PROFILE_LABEL=""

step=""
failed=0

# Same three-function vocabulary as install.sh and add-profile.sh's own
# --porcelain: one "ANYWH ..." line per event, so a single Rust-side parser
# (relay_setup.rs's parse_porcelain_line) drives every installer the app
# can run, without knowing which one it is. The last line of a successful
# run is "ANYWH done ok ...", same as install.sh's.
porcelain() {
  if [[ "$PORCELAIN" -eq 1 ]]; then echo "ANYWH $*"; fi
}

begin_step() {
  step="$1"
  porcelain "step $1"
}

end_step() {
  porcelain "done $*"
  step=""
}

err() {
  local code="$1"
  shift
  echo "error: $*" >&2
  failed=1
  porcelain "fail ${step:-setup} $code $*"
  exit 1
}

# A command that dies on its own under `set -e` (not through err()) still
# owes the porcelain stream exactly one fail line — same reasoning as
# install.sh's own EXIT trap.
trap '
  status=$?
  if [[ $status -ne 0 && $failed -eq 0 ]]; then
    porcelain "fail ${step:-setup} unexpected exited with status $status"
  fi
' EXIT

usage() {
  cat <<USAGE
Usage: app-install.sh --relay-host <ip> [--profile-label <text>] [--porcelain]
USAGE
}

# Mirror of ANYWH_ENV_DIR in infra/lib.sh (and of ENV_DIR in
# relay/src/profileRegistry.ts) — keep all three in sync.
ANYWH_ENV_DIR="${ANYWH_ENV_DIR:-$HOME/.config/anywh/env}"

# Blocks until something accepts a connection on host:port, or gives up.
#
# `brew services start` returns once launchd has accepted the job, which is
# a beat before the relay has bound anything — ~100ms measured on an Apple
# Silicon Mac, more on a cold first install, and the app dials the relay
# the instant this script exits. That gap is exactly long enough for the
# first-run wizard to show "couldn't verify the connection" for an install
# that succeeded.
#
# A copy of infra/lib.sh's function rather than a `source` of it, for the
# same reason the porcelain helpers above are copies of install.sh's: this
# file is embedded in the app (relay_setup.rs include_str!s it) and written
# out alone to a temp dir, so the only infra/lib.sh it could reach is the
# one inside the keg `brew install` just laid down — which is whatever
# version the tap currently points at, not this script's own. Sourcing it
# made the fix silently inert (`wait_for_relay: command not found`, then
# the original race) for every app newer than the tap. Verified against a
# real 0.1.3 keg before this was a copy.
#
# Counted attempts, not a deadline off bash's SECONDS: that is whole
# seconds since the shell started, so it can tick over a millisecond after
# this runs and wait none at all. Five per second of the budget, the first
# before any sleep so an already-listening relay costs nothing.
ANYWH_RELAY_READY_TIMEOUT="${ANYWH_RELAY_READY_TIMEOUT:-30}"

wait_for_relay() {
  local host="$1" port="$2"
  local attempts=$((ANYWH_RELAY_READY_TIMEOUT * 5))
  ((attempts > 0)) || attempts=1
  while ((attempts-- > 0)); do
    # Bash's own TCP redirection rather than nc/curl: neither is guaranteed
    # present, and this needs no parsing. The subshell is what closes the
    # descriptor.
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --porcelain) PORCELAIN=1; shift ;;
    --relay-host) RELAY_HOST="$2"; shift 2 ;;
    --relay-host=*) RELAY_HOST="${1#--relay-host=}"; shift ;;
    --profile-label) PROFILE_LABEL="$2"; shift 2 ;;
    --profile-label=*) PROFILE_LABEL="${1#--profile-label=}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; err bad_flag "unknown option: $1" ;;
  esac
done

begin_step flags
[[ -n "$RELAY_HOST" ]] || err bad_flag "--relay-host is required"
end_step "flags"

# --- 1. target -------------------------------------------------------------
begin_step target
[[ "$(uname -s)" == "Darwin" ]] || err unsupported_os "this installer only runs on macOS — use install.sh instead"
[[ "$(uname -m)" == "arm64" ]] || err unsupported_arch "anywh relay only ships for Apple Silicon Macs today, not Intel"
end_step "target os=Darwin arch=arm64"

# --- 2. prereqs --------------------------------------------------------------
# Node isn't checked here: `depends_on "node"` in the formula makes brew
# install (or already have) it, unlike install.sh's Linux path, which
# requires the user's own Node ahead of time because it has no package
# manager to lean on.
begin_step prereqs
command -v brew >/dev/null 2>&1 ||
  err brew_missing "Homebrew isn't installed — install it from https://brew.sh, then re-run this"

AGENT_BIN="${AGENT_BIN:-${CLAUDE_BIN:-claude}}"

# Same check install.sh runs, and — like there — reported rather than
# fatal: the relay installs, starts and serves with no agent CLI present,
# and resolves the binary at spawn time, so one installed after this ran
# needs nothing re-run here. See install.sh's own comment for the full
# reasoning and for why the two stripped variables matter.
#
# It matters more on this path than on that one: this script runs with the
# environment of the desktop app that spawned it, and a GUI app on macOS
# is launched by launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin — none of
# the places an agent CLI installs into. A `command -v` miss here is at
# least as likely to be that as a CLI that genuinely isn't installed,
# which is a terrible thing to refuse to install over.
agent_ready=1
if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  agent_ready=0
  echo "warning: the '$AGENT_BIN' CLI was not found on PATH — install and log in to your agent before your first conversation (https://docs.claude.com/en/docs/claude-code)" >&2
elif [[ "${ANYWH_SKIP_AGENT_LOGIN_CHECK:-0}" != "1" ]]; then
  auth_json="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$AGENT_BIN" auth status --json 2>/dev/null || true)"
  case "$(printf '%s' "$auth_json" | tr -d ' \n\r\t')" in
    *'"loggedIn":true'*) ;;
    *)
      agent_ready=0
      echo "warning: '$AGENT_BIN' isn't logged in — run '$AGENT_BIN login' on this machine before your first conversation. Set ANYWH_SKIP_AGENT_LOGIN_CHECK=1 to skip this check." >&2
      ;;
  esac
fi
end_step "prereqs agent=$AGENT_BIN agent_ready=$agent_ready"

# --- 3. install --------------------------------------------------------------
# The exact command the landing page and homebrew-tap/README.md show — brew
# taps anywh-sh/tap itself the first time a fully-qualified name is
# installed, so there is no separate `brew tap` step to keep in sync.
begin_step install
brew install anywh-sh/tap/anywh-relay ||
  err brew_install_failed "brew install anywh-sh/tap/anywh-relay failed — see the output above"
RELAY_PREFIX="$(brew --prefix anywh-relay)"
end_step "install dir=$RELAY_PREFIX/libexec"

# --- 4. profile --------------------------------------------------------------
# --mode dev: this script, like a human following the formula's caveats,
# has no systemd/launchd unit for add-profile.sh to enable — `brew services
# start` below is what actually runs the relay.
begin_step profile
set -- default --mode dev --relay-host "$RELAY_HOST" --resume
[[ -n "$PROFILE_LABEL" ]] && set -- "$@" --label "$PROFILE_LABEL"
[[ "$PORCELAIN" -eq 1 ]] && set -- "$@" --porcelain
"$RELAY_PREFIX/libexec/infra/systemd/add-profile.sh" "$@" ||
  err profile_failed "couldn't provision the 'default' profile — see the lines above; re-running this resumes from what was already written"
end_step "profile id=default"

# --- 5. service --------------------------------------------------------------
begin_step service
# Mirrors add-profile.sh's own "already running; left as is" — a re-run of
# this installer must not be the thing that restarts a relay with a
# conversation in flight.
if brew services info anywh-relay --json 2>/dev/null | grep -q '"status":"started"'; then
  echo "anywh-relay is already running; left as is"
  ready=1
else
  brew services start anywh-relay ||
    err service_failed "brew services start anywh-relay failed — see the output above"
  # The port is read back from the profile add-profile.sh just wrote rather
  # than assumed: it allocates the first free one, which is 8765 on a clean
  # machine and something else on one that already had it taken.
  ready=0
  relay_env="$ANYWH_ENV_DIR/default.env"
  # `|| true` on both: under `set -e` a failed substitution (no env file,
  # unreadable) would take the whole script down at the very last step,
  # after everything it exists to do already succeeded.
  relay_port="$(sed -n 's/^RELAY_PORT=//p' "$relay_env" 2>/dev/null | tail -n1 || true)"
  relay_bind="$(sed -n 's/^RELAY_HOST=//p' "$relay_env" 2>/dev/null | tail -n1 || true)"
  if [[ -n "$relay_port" ]] && wait_for_relay "${relay_bind:-$RELAY_HOST}" "$relay_port"; then
    ready=1
    echo "anywh-relay is answering on ${relay_bind:-$RELAY_HOST}:$relay_port"
  else
    echo "warning: anywh-relay didn't answer yet — check 'brew services info anywh-relay'" >&2
  fi
fi
end_step "service manager=launchd ready=$ready"

porcelain "done ok service=launchd install_dir=$RELAY_PREFIX/libexec"
