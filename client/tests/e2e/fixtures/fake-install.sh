#!/usr/bin/env bash
# Stand-in for install-relay.sh in the e2e tier, pointed at by
# ANYWH_INSTALL_SCRIPT (relay_setup.rs's override). It speaks the same
# porcelain (`ANYWH step|done|fail|profile ...`) the real installer does —
# that contract is what the app reads — but downloads nothing and touches
# no service manager: the "service" it starts is a real relay from this
# checkout's relay/dist, with the fake `claude` as its agent, on a free
# port, with every file it writes under ANYWH_E2E_INSTALL_DIR.
#
# A test makes a run fail by writing `<step> <code> <message>` to
# $ANYWH_E2E_INSTALL_DIR/fail before starting it; the file is consumed.
# The relay's PID goes to $ANYWH_E2E_INSTALL_DIR/relay.pid, so the spec can
# stop exactly that process and nothing else.
set -u

state="${ANYWH_E2E_INSTALL_DIR:?ANYWH_E2E_INSTALL_DIR is required}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
relay_dir="$(cd "$here/../../../../relay" && pwd)"

host=127.0.0.1 id=default mode=prod
while [ $# -gt 0 ]; do
  case "$1" in
    --relay-host) host="$2"; shift 2 ;;
    --profile-id) id="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --profile-label|--profile-home|--version) shift 2 ;;
    *) shift ;;
  esac
done

mkdir -p "$state/env" "$state/home" "$state/sessions-root"

fail_step="" fail_code="" fail_message=""
if [ -f "$state/fail" ]; then
  read -r fail_step fail_code fail_message < "$state/fail"
  rm -f "$state/fail"
fi

# A spec that must act while the installer is really running (cancel it)
# waits for `step-<name>` instead of for something already on screen.
step() {
  : > "$state/step-$1"
  echo "ANYWH step $1"
  if [ "$1" = "$fail_step" ]; then
    echo "$fail_message"
    echo "ANYWH fail $fail_step $fail_code $fail_message"
    exit 1
  fi
}

# Slow enough for a screenshot of each step in progress; a spec can stretch
# it by writing the seconds to $ANYWH_E2E_INSTALL_DIR/pause.
pause="${ANYWH_E2E_INSTALL_PAUSE:-1}"
if [ -f "$state/pause" ]; then read -r pause < "$state/pause"; fi

step flags; echo "ANYWH done flags"
step prereqs; sleep "$pause"; echo "ANYWH done prereqs node=$(node -p process.versions.node)"
step download; echo "resolving releases/latest/download/anywh-relay-linux-x64.tar.gz"; sleep "$pause"
echo "ANYWH done download asset=anywh-relay-linux-x64.tar.gz"
step install; sleep "$pause"; echo "ANYWH done install dir=$state/share"
step service

# A free port, then the relay on it. Picking a port and binding it are two
# steps, so another process can take it in between: if the relay dies
# instead of answering, it is retried on another port.
started=""
for _attempt in 1 2 3; do
  port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  # Its own session: the app cancels an install by signalling the
  # installer's process group, and the relay is the "service" — it
  # outlives the install.
  setsid env \
    RELAY_PORT="$port" RELAY_HOST="$host" \
    RELAY_HOME_OVERRIDE="$state/home" \
    ANYWH_ENV_DIR="$state/env" \
    RELAY_SESSIONS_FILE="$state/sessions.json" \
    RELAY_BACKGROUND_JOBS_FILE="$state/background-jobs.json" \
    RELAY_WAKEUPS_FILE="$state/wakeups.json" \
    RELAY_PUSH_DEVICES_FILE="$state/push-devices.json" \
    AGENT_BIN="$relay_dir/tests/fixtures/fake-claude.mjs" \
    SYSTEMCTL_BIN="$relay_dir/tests/fixtures/fake-systemctl.mjs" \
    ANYWH_AGENT_HOST_SOCKET="$state/agent-host.sock" \
    ANYWH_SESSIONS_ROOT="$state/sessions-root" \
    node "$relay_dir/dist/server.js" > "$state/relay.log" 2>&1 < /dev/null &
  pid=$!
  for _ in $(seq 1 100); do
    if node -e 'require("net").connect(+process.argv[1],"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))' "$port"; then
      started=1
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if [ -n "$started" ]; then
    echo "$pid" > "$state/relay.pid"
    break
  fi
  kill "$pid" 2>/dev/null
done
if [ -z "$started" ]; then
  echo "ANYWH fail service service_failed the relay never came up"
  exit 1
fi
echo "ANYWH done service manager=e2e"

step profile
echo "ANYWH profile id=$id port=$port host=$host mode=$mode env=$state/env/$id.env"
echo "ANYWH done profile id=$id"
echo "ANYWH done ok service=e2e"
