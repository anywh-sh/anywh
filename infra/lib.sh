# Shared by install.sh and add-profile.sh (infra/systemd/) and by
# app-install.sh (infra/homebrew/) — sourced, not executed. Bash only: the
# root install.sh is POSIX sh (it runs under `curl | sh`) and deliberately
# doesn't source this.
#
# Mirror of ENV_DIR in relay/src/profileRegistry.ts — keep both in sync.
# Duplicated instead of shared across the language boundary because
# systemd's EnvironmentFile can't source a shell variable, and the relay
# needs the value with no shell involved at all.
ANYWH_ENV_DIR="${ANYWH_ENV_DIR:-$HOME/.config/anywh/env}"

# How long wait_for_relay gives the relay to bind before giving up.
ANYWH_RELAY_READY_TIMEOUT="${ANYWH_RELAY_READY_TIMEOUT:-30}"

# Blocks until something accepts a connection on host:port, or the timeout
# runs out. Both ways the relay gets started return before it has bound
# anything — `systemctl --user enable --now` once systemd has forked the
# unit, `brew services start` once launchd has accepted the job — so an
# installer that reports success the moment they return is reporting on
# the service manager, not on the relay.
#
# That gap is small (~100ms measured on an Apple Silicon Mac, more on a
# cold first install) and it is exactly long enough to lose a race with
# the app's first-run wizard, which dials the relay the instant the
# installer exits and shows "couldn't verify the connection" for a
# connection refused it only had to wait a moment for.
#
# Never fails its caller: a relay slower than the timeout is still a far
# better outcome than an install marked failed, and every caller of this
# is followed by something that retries. Returns 0 if it answered, 1 if
# it didn't.
wait_for_relay() {
  local host="$1" port="$2"
  # Counted attempts, not a deadline computed from bash's SECONDS: that
  # variable is whole seconds since the shell started, so it can tick over
  # a millisecond after this function runs and turn "wait a second" into
  # waiting none at all. Five attempts per second of the budget, the first
  # one before any sleep so an already-listening relay costs nothing.
  local attempts=$((ANYWH_RELAY_READY_TIMEOUT * 5))
  ((attempts > 0)) || attempts=1
  while ((attempts-- > 0)); do
    # Bash's own TCP redirection rather than nc/curl: neither is guaranteed
    # present, and this needs no parsing. The subshell is what closes the
    # descriptor — `exec` with only a redirection applies it to the shell
    # itself, which here is the subshell, and it exits right after.
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}
