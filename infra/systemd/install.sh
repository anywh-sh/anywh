#!/usr/bin/env bash
# Renders anywh-relay@.service.template with this machine's paths (absolute
# relay/ directory, absolute node binary — none of which belong in a file
# committed to git). Run once per machine, not once per profile: the same
# rendered unit template serves every profile via systemd's instance
# mechanism (`anywh-relay@<profile>`), see infra/systemd/README.md.
#
# Default behavior only renders and prints the install steps, for a dev
# checkout where a human reads them before running anything with sudo-like
# effect on their own machine. `--apply` skips straight to performing
# them — used by the top-level install.sh (curl | sh, Fase 3), which
# extracts an already-built tarball non-interactively and has no human in
# the loop to read instructions to.
set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/../../relay" && pwd)"
# One rendered unit per template: the relay, and the agent host that keeps
# agent processes alive across relay restarts (same profile, same env files).
UNITS=(anywh-relay@ anywh-agent-host@)

source "$SCRIPT_DIR/../lib.sh"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

for unit in "${UNITS[@]}"; do
  sed \
    -e "s|{{WORKING_DIRECTORY}}|$RELAY_DIR|g" \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{ENV_DIR}}|$ANYWH_ENV_DIR|g" \
    "$SCRIPT_DIR/$unit.service.template" > "$SCRIPT_DIR/$unit.service"
done

if [[ "$APPLY" -eq 0 ]]; then
  cat <<EOF
Rendered: $SCRIPT_DIR/anywh-relay@.service
          $SCRIPT_DIR/anywh-agent-host@.service

Install them once per machine (user-scope units — no sudo):
  mkdir -p "$HOME/.config/systemd/user"
  cp "$SCRIPT_DIR/anywh-relay@.service" "$SCRIPT_DIR/anywh-agent-host@.service" "$HOME/.config/systemd/user/"
  systemctl --user daemon-reload

  # Needed once per machine so the unit keeps running without an active
  # login session — the default for a user-scope unit on a headless box is
  # to stop the moment the last session for that user ends.
  loginctl enable-linger "$(whoami)"

Then, per profile (e.g. "default", or "pessoal"/"trabalho" for more than
one), point it at a built relay and enable the instance:
  cd "$RELAY_DIR" && npm install && npm run build
  cp .env.example .env   # edit as needed — see infra/systemd/README.md
  systemctl --user enable --now anywh-relay@default anywh-agent-host@default
EOF
  exit 0
fi

mkdir -p "$HOME/.config/systemd/user"
for unit in "${UNITS[@]}"; do
  cp "$SCRIPT_DIR/$unit.service" "$HOME/.config/systemd/user/$unit.service"
done
systemctl --user daemon-reload
loginctl enable-linger "$(whoami)"
echo "Installed the anywh-relay@ and anywh-agent-host@ units and enabled linger for $(whoami)."
