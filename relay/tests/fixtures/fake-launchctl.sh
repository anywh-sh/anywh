#!/bin/sh
# Stands in for `launchctl` (LAUNCHCTL_BIN), the macOS counterpart of
# fake-systemctl.mjs: the real one reaches the user's live launchd session,
# where a test could stop a real profile's relay that shares its id. Plain
# sh, not node: add-profile.sh runs it on a PATH that must work without Node.
#
# FAKE_LAUNCHCTL_ARGV_FILE, if set, gets each call's argv as one line,
# space-separated. `print gui/<uid>/<label>` succeeds only for a label listed
# in FAKE_LAUNCHCTL_LOADED (space-separated), or in the file named by
# FAKE_LAUNCHCTL_LOADED_FILE (read on every call, so a test can unload a job
# while the relay waits), like a loaded job; everything else succeeds and
# does nothing.
if [ -n "$FAKE_LAUNCHCTL_ARGV_FILE" ]; then
  echo "$*" >> "$FAKE_LAUNCHCTL_ARGV_FILE"
fi
if [ "$1" = "print" ]; then
  label="${2##*/}"
  file_loaded=""
  if [ -n "$FAKE_LAUNCHCTL_LOADED_FILE" ] && [ -f "$FAKE_LAUNCHCTL_LOADED_FILE" ]; then
    file_loaded="$(cat "$FAKE_LAUNCHCTL_LOADED_FILE")"
  fi
  for loaded in $FAKE_LAUNCHCTL_LOADED $file_loaded; do
    [ "$loaded" = "$label" ] && exit 0
  done
  echo "Could not find service \"$label\" in domain" >&2
  exit 113
fi
exit 0
