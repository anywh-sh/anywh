#!/usr/bin/env bash
# The front door: https://anywh.sh/install, and the one command the landing
# page shows.
#
#   curl -fsSL https://anywh.sh/install | sh
#   curl -fsSL https://anywh.sh/install | sh -s -- --relay-only
#   curl -fsSL https://anywh.sh/install | sh -s -- --profile-id home --relay-host auto
#
# anywh is two programs, and for a long time this URL only installed one of
# them. The **relay** is the headless service that runs your agent on the
# machine your code lives on; the **app** is the window you talk to it from.
# Someone who found the project on the landing page, ran the line it shows
# and expected software to appear got a systemd user unit, no window, and
# nothing on PATH — "I installed it and nothing happened" was an accurate
# description of a correct run. This script exists so the obvious command
# does the obvious thing, with the relay one flag away.
#
# Routing, in order:
#
#   --relay-only              the relay, explicitly.
#   a profile flag            the relay, implicitly: --profile-id,
#                             --profile-label, --relay-host, --profile-home,
#                             --mode, --no-profile. Nothing that asks for a
#                             profile can mean anything but the relay, and
#                             this is what keeps every documented command
#                             working verbatim — the README's, the landing
#                             page's, homebrew-tap's caveats, and the one
#                             the app's own first-run wizard runs.
#   neither                   the relay, for now.
#
# Delegation, not reimplementation: the relay install lives in
# install-relay.sh and is not duplicated here, because the app embeds that
# exact file (client/src-tauri/src/relay_setup.rs `include_str!`s it) and
# drives it with --porcelain for the in-app "Set up on this machine". One
# implementation, three callers.
#
# Written for POSIX sh, not bash, for the same reason install-relay.sh
# documents at length: piped to `sh` the shebang above is just a comment,
# and this runs under whatever /bin/sh happens to be — dash on Debian. No
# arrays, no [[ ]], no pipefail.
set -eu

REPO="anywh-sh/anywh"
RELAY_SCRIPT="install-relay.sh"

# Where the delegated script is fetched from when there is no sibling copy.
# Only set by tests (serving a checkout's own scripts from localhost) and by
# a mirror; the default is GitHub's `releases/latest/download` redirect, the
# same one install-relay.sh resolves its tarball through.
RELEASE_BASE_URL="${ANYWH_RELEASE_BASE_URL:-}"

err() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage: install.sh [--relay-only] [flags passed through]

  Installs anywh. With no flags, installs the relay.

  --relay-only           Install the relay: the headless service that runs
                         your agent on this machine. Implied by any of the
                         profile flags below.

  Passed straight through to the relay installer, each implying
  --relay-only: --profile-id, --profile-label, --relay-host, --profile-home,
  --mode, --no-profile. --version and --porcelain are passed through too and
  imply nothing. See https://github.com/${REPO}/blob/main/docs/self-hosting.md
  for what each one does.
USAGE
}

# --- routing ---------------------------------------------------------------
# Every argument that isn't one of this script's own is handed back to the
# delegate untouched, in its original order (shift off the front, append to
# the back — after one full pass "$@" is what it was, minus ours).
route=auto

imply_relay() {
  if [ "$route" = auto ]; then route=relay; fi
}

remaining=$#
while [ "$remaining" -gt 0 ]; do
  arg="$1"
  shift
  remaining=$((remaining - 1))
  case "$arg" in
    --relay-only)
      route=relay
      continue
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --profile-id | --profile-id=* | --profile-label | --profile-label=* | --relay-host | --relay-host=* | --profile-home | --profile-home=* | --mode | --mode=* | --no-profile)
      imply_relay
      ;;
  esac
  set -- "$@" "$arg"
done

if [ "$route" = auto ]; then route=relay; fi

# --- delegation ------------------------------------------------------------
# A sibling copy wins over a download, and that is not only an optimization:
# `./install.sh` run from a git checkout or from an extracted release tree
# has to run *that* tree's relay installer, not whatever the newest release
# published. It is what the test suite depends on to exercise the code under
# test, and what makes a mirrored or vendored copy self-contained.
#
# Piped from curl there is no path to be a sibling of — `$0` is "sh" — so the
# download is the normal case, not the fallback.
script_dir=""
case "$0" in
  */*) script_dir="${0%/*}" ;;
esac

if [ -n "$script_dir" ] && [ -f "$script_dir/$RELAY_SCRIPT" ]; then
  if [ -x "$script_dir/$RELAY_SCRIPT" ]; then
    exec "$script_dir/$RELAY_SCRIPT" "$@"
  fi
  exec sh "$script_dir/$RELAY_SCRIPT" "$@"
fi

tmp=""
cleanup() {
  [ -n "$tmp" ] && rm -rf "$tmp"
}
trap cleanup EXIT

tmp="$(mktemp -d)"
base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"

curl -fsSL "$base_url/$RELAY_SCRIPT" -o "$tmp/$RELAY_SCRIPT" ||
  err "couldn't download $RELAY_SCRIPT from $base_url"

# The script is about to run as this user, so it gets the same treatment the
# relay tarball already gets rather than being trusted for having arrived
# over TLS: one more round trip buys a checksum that covers what executes.
curl -fsSL "$base_url/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  err "couldn't download SHA256SUMS from $base_url"

expected="$(grep " $RELAY_SCRIPT\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] ||
  err "checksum for $RELAY_SCRIPT not found in SHA256SUMS — the release may still be publishing, try again shortly"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$RELAY_SCRIPT" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$RELAY_SCRIPT" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] ||
  err "checksum mismatch for $RELAY_SCRIPT (expected $expected, got $actual)"

# Run, don't exec: the EXIT trap above is what removes the temp directory,
# and exec would replace this shell before it could fire. The delegate's
# exit status is this script's own — a caller parsing --porcelain must see
# the same last line and the same status it saw when there was one script.
set +e
sh "$tmp/$RELAY_SCRIPT" "$@"
status=$?
set -e
exit "$status"
