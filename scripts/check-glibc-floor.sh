#!/bin/sh
# Fails when a native module under <dir> needs a newer glibc than <floor>.
#
#   scripts/check-glibc-floor.sh <dir> <floor>      e.g. stage 2.35
#
# A .node built on a newer distro links against that distro's glibc, and the
# relay then fails to start (node-pty refuses to load) on every machine with
# an older one — the official Linux relay once needed GLIBC_2.42 and did not
# run on Debian 13 (2.41). Modules for other platforms (Mach-O, PE) carry no
# GLIBC symbols and are skipped.
set -eu
dir="$1"
floor="$2"
bad=0
checked=0
for module in $(find "$dir" -name '*.node' -type f); do
  need="$(objdump -T "$module" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n 1 || true)"
  [ -n "$need" ] || continue
  checked=$((checked + 1))
  newest="$(printf '%s\n%s\n' "$need" "$floor" | sort -V | tail -n 1)"
  if [ "$newest" != "$floor" ]; then
    echo "::error::$module needs GLIBC_$need, newer than the GLIBC_$floor floor"
    bad=1
  else
    echo "$module: GLIBC_$need (floor $floor)"
  fi
done
[ "$checked" -gt 0 ] || { echo "::error::no Linux native module found under $dir"; exit 1; }
exit "$bad"
