#!/usr/bin/env bash
# Downloads, verifies, and installs the anywh relay as a systemd user
# service. Linux and macOS (Apple Silicon) only — on Windows, run this
# inside WSL2.
#
#   curl -fsSL https://anywh.sh/install | sh
#   curl -fsSL https://anywh.sh/install | sh -s -- --version v0.1.1
#   curl -fsSL https://anywh.sh/install | sh -s -- --profile-id home --relay-host auto
#
# Installs the latest release unless --version pins one. With no profile
# flags it stops after the service and prints how to create the first
# profile by hand; with them it provisions that profile too, so a single
# run takes a bare machine to a listening relay. Safe to re-run: the tree
# under INSTALL_DIR is swapped in whole (never left half-extracted), and
# profile state (~/.config/anywh/env/, tracked by infra/lib.sh) is only ever
# added to, never rewritten unless it matches.
#
# Written for POSIX sh, not bash: `curl | sh` runs it under whatever /bin/sh
# is (dash on Debian), so no arrays, no [[ ]], no `trap ERR` — and no
# `pipefail` either, a bash/ksh extension dash doesn't have: it used to be
# on this line, and dash rejected it outright (`set: Illegal option -o
# pipefail`) before the script did anything at all, on the exact platform
# the line above calls out by name. None of this script's pipes need it —
# each one's exit status that matters is its last stage's, already covered
# by plain `-e`.
set -eu

REPO="anywh-sh/anywh"
INSTALL_DIR="${ANYWH_INSTALL_DIR:-$HOME/.local/share/anywh}"
# Where release assets are fetched from. Only set by tests (a tarball built
# from the checkout, served locally) and by a mirror — the default is
# GitHub's own release download URLs, chosen below once the version is known.
RELEASE_BASE_URL="${ANYWH_RELEASE_BASE_URL:-}"

# --- porcelain -----------------------------------------------------------
# Machine-readable progress for whatever drives this script as a program
# (the desktop app's own first-run setup): one line per event, interleaved
# with the prose a human reads. Off by default, so `curl | sh` output is
# exactly what it was.
#
#   ANYWH step <id>                 a step began
#   ANYWH done <id> [key=value ...] it finished, with what it learned
#   ANYWH fail <id> <code> <text>   it failed; `code` is stable, `text` is not
#
# The last line of a successful run is `ANYWH done ok ...`. A failure always
# ends in exactly one `fail` line — err() writes it for the errors this
# script knows to expect, and the EXIT trap writes it for a command that
# died on its own under `set -e`, which used to exit with no word about
# where.
PORCELAIN=0
step=""
failed=0

porcelain() {
  if [ "$PORCELAIN" -eq 1 ]; then echo "ANYWH $*"; fi
}

begin_step() {
  step="$1"
  porcelain "step $1"
}

end_step() {
  porcelain "done $*"
  step=""
}

# err <code> <message...>
err() {
  code="$1"
  shift
  echo "error: $*" >&2
  failed=1
  porcelain "fail ${step:-setup} $code $*"
  exit 1
}

tmp=""
staging=""
old_suffix=""

cleanup() {
  status=$?
  [ -n "$tmp" ] && rm -rf "$tmp"
  # A death between extracting and swapping leaves the staging tree; one
  # between the two mv's leaves the previous tree under `.old.` — sweep both
  # so a retry starts clean. The live tree is never touched here.
  [ -n "$staging" ] && rm -rf "$staging"
  [ -n "$old_suffix" ] && rm -rf "$INSTALL_DIR/relay.old.$old_suffix" "$INSTALL_DIR/infra.old.$old_suffix"
  if [ "$status" -ne 0 ] && [ "$failed" -eq 0 ]; then
    porcelain "fail ${step:-setup} unexpected exited with status $status"
  fi
}
trap cleanup EXIT

usage() {
  cat <<USAGE
Usage: install.sh [--version <tag>] [--porcelain] [--mode dev|prod]
                  [--profile-id <id>] [--profile-label <text>]
                  [--relay-host <ip>|auto] [--profile-home <path>] [--no-profile]

  --version <tag>        Install that release instead of the latest.
                         Accepts "v0.1.1" or "0.1.1".
  --porcelain            Emit machine-readable "ANYWH ..." progress lines.
  --mode dev|prod        prod (default) registers the systemd user unit and
                         enables the profile's instance; dev touches no
                         systemd at all and prints the run command instead.

  Any of the following provisions the first profile once the relay is in:
  --profile-id <id>      Profile id (default: derived from --profile-label,
                         else "default").
  --profile-label <text> Display label (default: the id).
  --relay-host <ip>      Address other devices reach this machine on — or
                         "auto" to pick the tailnet address, else the one
                         private LAN address. Required when provisioning.
  --profile-home <path>  Isolated \$HOME for this profile's agent login.
  --no-profile           Skip provisioning even if the flags above appear.
USAGE
}

# --- 0. flags --------------------------------------------------------------
# Parsed and validated before anything else so a typo costs nothing: no
# target detection, no prerequisite checks, no network.
VERSION=""
MODE=""
PROFILE_ID=""
PROFILE_LABEL=""
RELAY_HOST=""
PROFILE_HOME=""
PROVISION=0
NO_PROFILE=0

# need_value <flag> <argc> — the flag was given without its value.
need_value() {
  [ "$2" -ge 2 ] || err bad_flag "$1 needs a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) need_value "$1" $#; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    --porcelain) PORCELAIN=1; shift ;;
    --mode) need_value "$1" $#; MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --profile-id) need_value "$1" $#; PROFILE_ID="$2"; PROVISION=1; shift 2 ;;
    --profile-id=*) PROFILE_ID="${1#--profile-id=}"; PROVISION=1; shift ;;
    --profile-label) need_value "$1" $#; PROFILE_LABEL="$2"; PROVISION=1; shift 2 ;;
    --profile-label=*) PROFILE_LABEL="${1#--profile-label=}"; PROVISION=1; shift ;;
    --relay-host) need_value "$1" $#; RELAY_HOST="$2"; PROVISION=1; shift 2 ;;
    --relay-host=*) RELAY_HOST="${1#--relay-host=}"; PROVISION=1; shift ;;
    --profile-home) need_value "$1" $#; PROFILE_HOME="$2"; PROVISION=1; shift 2 ;;
    --profile-home=*) PROFILE_HOME="${1#--profile-home=}"; PROVISION=1; shift ;;
    --no-profile) NO_PROFILE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; err bad_flag "unknown option: $1" ;;
  esac
done

begin_step flags

if [ -z "$MODE" ]; then MODE="prod"; fi
case "$MODE" in
  dev | prod) ;;
  *) err bad_flag "--mode must be 'dev' or 'prod', got '$MODE'" ;;
esac

if [ "$NO_PROFILE" -eq 1 ]; then
  [ "$PROVISION" -eq 0 ] || err bad_flag "--no-profile can't be combined with profile flags"
fi

# The id is the installer's to make, never a caller's re-implementation of
# the relay's own slug rule: lowercase, anything outside [a-z0-9] collapsed
# to one hyphen, trimmed. The same label yields the same id every run, which
# is what lets a re-run resume instead of creating a sibling.
slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9][^a-z0-9]*/-/g' -e 's/^-//' -e 's/-$//'
}

if [ "$PROVISION" -eq 1 ]; then
  if [ -z "$PROFILE_ID" ] && [ -n "$PROFILE_LABEL" ]; then PROFILE_ID="$(slugify "$PROFILE_LABEL")"; fi
  if [ -z "$PROFILE_ID" ]; then PROFILE_ID="default"; fi
  # Same rule add-profile.sh enforces, checked here so it fails before the
  # download rather than after it.
  case "$PROFILE_ID" in
    "" | -* | *[!a-z0-9-]*) err bad_flag "invalid profile id '$PROFILE_ID' (lowercase letters, digits and hyphens, not starting with a hyphen)" ;;
  esac
  # Never defaulted, never inherited: a profile that silently lands on
  # loopback runs fine here and is unreachable from every other device,
  # with no symptom at all.
  [ -n "$RELAY_HOST" ] || err bad_flag "--relay-host is required when provisioning a profile — an IP other devices reach this machine on, or 'auto'"
fi

end_step "flags mode=$MODE provision=$PROVISION"

# --- 1. detect target -------------------------------------------------
# Matches the three legs release.yml's build-relay job publishes —
# no darwin-x64 (Intel Mac) and no native Windows.
begin_step target
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)
    case "$arch" in
      x86_64) target="linux-x64" ;;
      aarch64 | arm64) target="linux-arm64" ;;
      *) err unsupported_arch "unsupported Linux architecture: $arch" ;;
    esac
    # The one service manager this script knows how to drive.
    service="systemd"
    ;;
  Darwin)
    case "$arch" in
      arm64) target="darwin-arm64" ;;
      *) err unsupported_arch "anywh relay only ships for Apple Silicon Macs today, not Intel (arch: $arch)" ;;
    esac
    # No launchd here: the macOS service is the Homebrew formula's job
    # (`brew install anywh-sh/tap/anywh-relay`). This script still installs
    # the tree, then stops short of anything it can't keep running, instead
    # of dying inside the systemd step after a complete download.
    service="none"
    ;;
  *) err unsupported_os "unsupported OS: $os — on Windows, run this inside WSL2" ;;
esac
# Decided here, once, so every later step agrees: the service is only ever
# registered when there is a manager for it *and* the caller asked for one.
if [ "$MODE" = "dev" ]; then service="none"; fi
end_step "target os=$os arch=$arch target=$target service=$service"

# --- 2. prerequisites ---------------------------------------------------
# Detected, not installed — same reasoning as the agent CLI check below:
# both are things the user's account/machine needs regardless of anywh,
# not something this script should be trusted to install for them.
begin_step prereqs
command -v node >/dev/null 2>&1 || err node_missing "Node.js >=20.12 is required — install it first (https://nodejs.org), then re-run this script"

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_minor="$(echo "$node_version" | cut -d. -f2)"
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 12 ]; }; then
  err node_old "Node.js >=20.12 is required, found $node_version"
fi

# The same binary the relay will spawn (relay/src/claudeCliConfig.ts reads
# AGENT_BIN, then the older CLAUDE_BIN, then falls back to `claude`) — the
# literal `claude` used to be checked here even when the relay was going to
# run something else.
AGENT_BIN="${AGENT_BIN:-${CLAUDE_BIN:-claude}}"
command -v "$AGENT_BIN" >/dev/null 2>&1 ||
  err agent_missing "the '$AGENT_BIN' CLI was not found on PATH — install and log in to your agent first (https://docs.claude.com/en/docs/claude-code), then re-run this script"

# Presence isn't enough: the relay refuses to create a profile whose agent
# isn't logged in, and that used to surface only after the install, as a
# 409 from the control API. Same command the relay runs, with the same two
# variables stripped — with an API key in the environment the CLI reports
# `loggedIn: true` through the key, which is precisely the false positive
# this check exists to catch (billing would land on the key, not the
# subscription). ANYWH_SKIP_AGENT_LOGIN_CHECK=1 is the opt-out for a box
# where the login is done later, or for a CLI that has no `auth status`.
if [ "${ANYWH_SKIP_AGENT_LOGIN_CHECK:-0}" != "1" ]; then
  auth_json="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$AGENT_BIN" auth status --json 2>/dev/null || true)"
  case "$(printf '%s' "$auth_json" | tr -d ' \n\r\t')" in
    *'"loggedIn":true'*) ;;
    *) err agent_not_logged_in "'$AGENT_BIN' isn't logged in — run '$AGENT_BIN login' on this machine (as the user who will run the relay), then re-run this script. Set ANYWH_SKIP_AGENT_LOGIN_CHECK=1 to skip this check." ;;
  esac
fi

# A user-scope unit needs a user manager to talk to, and a session without
# one (a bare `ssh user@box` on some setups, a container, a chroot) only
# reveals that at the very last step — after the whole download. Asked up
# front instead. `--mode dev` never touches systemd, so it skips this.
if [ "$service" = "systemd" ]; then
  systemctl --user show-environment >/dev/null 2>&1 ||
    err no_user_systemd "systemd --user isn't reachable in this session (no XDG_RUNTIME_DIR / user D-Bus) — log in as the user (a real login session, or 'loginctl enable-linger' + 'machinectl shell user@'), or re-run with --mode dev to run the relay without a service"
fi
end_step "prereqs node=$node_version agent=$AGENT_BIN"

# --- 2b. relay host ---------------------------------------------------------
# Resolved before the download, not after: an undetectable address is a
# question for the human, and asking it after 40 s of download is rude.
#
# `auto` prefers the tailnet address (100.64.0.0/10 — the one that stays the
# same from anywhere) over a single private LAN address, and gives up rather
# than guess when there are several of those. Never loopback: that is
# exactly the silent failure --relay-host exists to prevent.
classify_ip() {
  IFS=. read -r o1 o2 _ _ <<ADDR
$1
ADDR
  case "$o1" in
    127) echo loopback ;;
    100) if [ "$o2" -ge 64 ] && [ "$o2" -le 127 ]; then echo tailnet; else echo public; fi ;;
    10) echo lan ;;
    172) if [ "$o2" -ge 16 ] && [ "$o2" -le 31 ]; then echo lan; else echo public; fi ;;
    192) if [ "$o2" -eq 168 ]; then echo lan; else echo public; fi ;;
    *) echo public ;;
  esac
}

# Container and VM bridges (docker0, br-*, veth*, virbr*, lxdbr*) carry a
# private address no other device can reach — on a box with Docker they
# would make "exactly one LAN address" false on every machine. Skipped by
# interface name where the name is known (`ip`); `ifconfig`'s inet lines
# carry no name, and macOS has none of these bridges anyway.
local_ipv4_addresses() {
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show scope global 2>/dev/null |
      awk '$2 !~ /^(docker[0-9]*|br-|veth|virbr|lxdbr|lxcbr|cni|flannel|podman)/ {print $4}' | cut -d/ -f1
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet / {print $2}' | sed 's/^addr://'
  fi
}

detect_relay_host() {
  tailnet=""
  lan=""
  lan_count=0
  for addr in $(local_ipv4_addresses); do
    case "$(classify_ip "$addr")" in
      tailnet) [ -n "$tailnet" ] || tailnet="$addr" ;;
      lan) lan_count=$((lan_count + 1)); lan="$addr" ;;
    esac
  done
  if [ -n "$tailnet" ]; then echo "$tailnet"; return 0; fi
  if [ "$lan_count" -eq 1 ]; then echo "$lan"; return 0; fi
  return 1
}

if [ "$PROVISION" -eq 1 ] && [ "$RELAY_HOST" = "auto" ]; then
  begin_step relay_host
  RELAY_HOST="$(detect_relay_host)" ||
    err relay_host_undetectable "couldn't pick this machine's address on its own (no tailnet address, and not exactly one private LAN address) — pass --relay-host explicitly"
  end_step "relay_host host=$RELAY_HOST"
fi

# --- 3. download + verify ------------------------------------------------
# Every release carries the same tarball under two names. The unversioned one
# resolves to the newest release through GitHub's own
# `releases/latest/download` redirect — no API call, no jq dependency on a
# bare box. The versioned one is the only way to address an older release,
# since that redirect only ever points at the newest.
begin_step download
if [ -n "$VERSION" ]; then
  version="${VERSION#v}"
  asset="anywh-relay-${version}-${target}.tar.gz"
  base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download/v${version}}"
else
  asset="anywh-relay-${target}.tar.gz"
  base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
fi

tmp="$(mktemp -d)"

echo "Downloading $asset..."
curl -fsSL "$base_url/$asset" -o "$tmp/$asset" ||
  err download_failed "couldn't download $asset — check that the release exists and ships an asset for $target: $base_url"
curl -fsSL "$base_url/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  err download_failed "couldn't download SHA256SUMS from $base_url"

expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || err checksum_missing "checksum for $asset not found in SHA256SUMS — the release may still be publishing, try again shortly"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
fi
# Not retryable blindly: the same bytes will fail the same way. Either the
# download was corrupted in transit (rare) or the asset was tampered with.
[ "$expected" = "$actual" ] || err checksum_mismatch "checksum mismatch for $asset (expected $expected, got $actual)"
echo "Checksum verified."
end_step "download asset=$asset"

# --- 4. install -----------------------------------------------------------
# Extracted into a staging directory beside the live tree and swapped in
# with two renames, so no moment exists in which INSTALL_DIR holds half a
# relay: the old `rm -rf` then `tar` had exactly that window, and a service
# under Restart=always that woke up inside it crash-looped on a missing
# dist/server.js. Staging lives *inside* INSTALL_DIR on purpose — a rename
# across filesystems degrades to a copy, and the window would be back.
begin_step install
mkdir -p "$INSTALL_DIR"
for leftover in "$INSTALL_DIR"/.staging.* "$INSTALL_DIR"/relay.old.* "$INSTALL_DIR"/infra.old.*; do
  [ -e "$leftover" ] && rm -rf "$leftover"
done

staging="$INSTALL_DIR/.staging.$$"
mkdir "$staging"
tar xzf "$tmp/$asset" -C "$staging" || err extract_failed "couldn't extract $asset into $staging (disk full, or a damaged archive)"
# The two files everything downstream stands on. A tarball without them
# is refused before it can replace a working install.
[ -f "$staging/relay/dist/server.js" ] && [ -f "$staging/infra/systemd/add-profile.sh" ] ||
  err tarball_incomplete "$asset doesn't contain a complete relay (relay/dist/server.js and infra/systemd/add-profile.sh) — the previous install, if any, was left untouched"

old_suffix="$$"
[ -e "$INSTALL_DIR/relay" ] && mv "$INSTALL_DIR/relay" "$INSTALL_DIR/relay.old.$old_suffix"
[ -e "$INSTALL_DIR/infra" ] && mv "$INSTALL_DIR/infra" "$INSTALL_DIR/infra.old.$old_suffix"
mv "$staging/relay" "$INSTALL_DIR/relay"
mv "$staging/infra" "$INSTALL_DIR/infra"
rm -rf "$staging"
staging=""
rm -rf "$INSTALL_DIR/relay.old.$old_suffix" "$INSTALL_DIR/infra.old.$old_suffix"
old_suffix=""
echo "Installed to $INSTALL_DIR"
end_step "install dir=$INSTALL_DIR"

# --- 5. service ------------------------------------------------------------
begin_step service
if [ "$service" = "systemd" ]; then
  "$INSTALL_DIR/infra/systemd/install.sh" --apply || err service_failed "couldn't register the anywh-relay@ systemd user unit"
elif [ "$os" = "Darwin" ]; then
  cat <<NOTE

No service was registered: this script has no launchd unit to offer. To
keep the relay running across logins on macOS, use the Homebrew formula
instead of (or after) this install:
  brew install anywh-sh/tap/anywh-relay
NOTE
fi
end_step "service manager=$service"

# --- 6. profile ------------------------------------------------------------
# The first profile is provisioned by the installer, not by the relay's
# own control API: that API never passes --relay-host, and add-profile.sh
# only inherits one from an *existing* .env — with none yet, the first
# profile would land on loopback. From the second profile on, the API is
# the normal path.
if [ "$PROVISION" -eq 1 ]; then
  begin_step profile
  # No manager to enable an instance in: dev mode prints the run command.
  profile_mode="$MODE"
  if [ "$service" = "none" ]; then profile_mode="dev"; fi
  set -- "$PROFILE_ID" --relay-host "$RELAY_HOST" --mode "$profile_mode" --resume
  if [ -n "$PROFILE_LABEL" ]; then set -- "$@" --label "$PROFILE_LABEL"; fi
  if [ -n "$PROFILE_HOME" ]; then set -- "$@" --home "$PROFILE_HOME"; fi
  if [ "$PORCELAIN" -eq 1 ]; then set -- "$@" --porcelain; fi
  "$INSTALL_DIR/infra/systemd/add-profile.sh" "$@" ||
    err profile_failed "couldn't provision the profile '$PROFILE_ID' — see the lines above; re-running this command resumes from what was already written"
  end_step "profile id=$PROFILE_ID host=$RELAY_HOST mode=$profile_mode"
else
  cat <<NEXT

Next: create your first profile —
  "$INSTALL_DIR/infra/systemd/add-profile.sh" default --relay-host <this-machine's-tailscale-or-lan-ip>

See https://github.com/${REPO}/blob/main/infra/systemd/README.md for what
--relay-host should be and how multi-profile setups work.
NEXT
fi

porcelain "done ok service=$service install_dir=$INSTALL_DIR"
