#!/usr/bin/env bash
# Restarts every enabled anywh-relay profile instance without the caller
# needing to know profile ids ahead of time. Discovers them from the
# default.target.wants/ symlinks systemd itself created on `enable` (one per
# profile, see add-profile.sh) instead of a hardcoded list, so a newly added
# profile is picked up automatically. A relay installed from a release
# does not need this to pick up an update: it restarts itself onto a newer
# release once it is idle (relay/src/update/releaseWatch.ts). This is for a
# checkout, after `npm run build`.
set -euo pipefail

WANTS_DIR="$HOME/.config/systemd/user/default.target.wants"

mapfile -t UNITS < <(find "$WANTS_DIR" -maxdepth 1 -name 'anywh-relay@*.service' -printf '%f\n' 2>/dev/null | sort)

if [[ ${#UNITS[@]} -eq 0 ]]; then
  echo "error: no enabled anywh-relay profile found in $WANTS_DIR" >&2
  exit 1
fi

echo "Restarting ${#UNITS[@]} profile(s): ${UNITS[*]}"
systemctl --user restart "${UNITS[@]}"
systemctl --user --no-pager status "${UNITS[@]}"
