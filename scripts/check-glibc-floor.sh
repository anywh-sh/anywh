#!/bin/sh
# Fails when a native module under <dir> needs a newer glibc or libstdc++
# than the floor below.
#
#   scripts/check-glibc-floor.sh <dir>
#
# A .node built on a newer distro links against that distro's glibc and
# libstdc++, and the relay then fails to start (node-pty refuses to load) on
# every machine with an older one — the official Linux relay once needed
# GLIBC_2.42 and did not run on Debian 13 (2.41). node-pty is C++, so its
# GLIBCXX_/CXXABI_ needs matter as much as its GLIBC_ ones.
#
# The floor is Ubuntu 22.04's stock runtime (glibc 2.35, libstdc++ from
# GCC 12: GLIBCXX_3.4.30, CXXABI_1.3.13), which Debian 12 matches. The
# GLIBC_FLOOR, GLIBCXX_FLOOR and CXXABI_FLOOR environment variables override
# it — the test uses them; the workflows don't.
#
# Modules for other platforms (Mach-O, PE — node-pty ships darwin-* and
# win32-* prebuilds) are not ELF and are skipped. An ELF module objdump can't
# read fails the check: an unreadable module is not a passing one.
set -eu

glibc_floor="${GLIBC_FLOOR:-2.35}"
glibcxx_floor="${GLIBCXX_FLOOR:-3.4.30}"
cxxabi_floor="${CXXABI_FLOOR:-1.3.13}"

[ "$#" -eq 1 ] || { echo "usage: $0 <dir>" >&2; exit 2; }
dir="$1"
[ -d "$dir" ] || { echo "::error::$dir is not a directory"; exit 1; }
command -v objdump > /dev/null 2>&1 || {
  echo "::error::objdump not found — install binutils to check the glibc floor"
  exit 1
}

# Prints the newest of the dotted versions read from stdin (one per line),
# or nothing for empty input. awk instead of `sort -V`, which is GNU-only.
newest() {
  awk -F. '
    function gt(a, b,   x, y, n, i) {
      n = split(a, x, ".")
      if (split(b, y, ".") > n) n = split(b, y, ".")
      for (i = 1; i <= n; i++) {
        if ((x[i] + 0) > (y[i] + 0)) return 1
        if ((x[i] + 0) < (y[i] + 0)) return 0
      }
      return 0
    }
    NF { if (best == "" || gt($0, best)) best = $0 }
    END { if (best != "") print best }
  '
}

is_elf() {
  [ "$(dd if="$1" bs=4 count=1 2> /dev/null | od -An -tx1 | tr -d ' \n')" = 7f454c46 ]
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# A file list read line by line, not `for m in $(find ...)`: paths with
# spaces stay whole. A path with a newline in it splits into lines that
# aren't files, and those fail below instead of passing.
find "$dir" -type f -name '*.node' > "$tmp/modules"

bad=0
checked=0
while IFS= read -r module; do
  if [ ! -f "$module" ]; then
    echo "::error::$module: listed by find but not a readable file"
    bad=1
    continue
  fi
  is_elf "$module" || continue
  if ! objdump -T "$module" > "$tmp/symbols" 2> "$tmp/err"; then
    echo "::error::$module: objdump could not read it: $(tr '\n' ' ' < "$tmp/err")"
    bad=1
    continue
  fi
  checked=$((checked + 1))
  summary=""
  for lib in GLIBC GLIBCXX CXXABI; do
    case "$lib" in
      GLIBC) floor="$glibc_floor" ;;
      GLIBCXX) floor="$glibcxx_floor" ;;
      CXXABI) floor="$cxxabi_floor" ;;
    esac
    # GLIBC_ followed by a digit never matches inside a GLIBCXX_ name.
    need="$(grep -o "${lib}_[0-9][0-9.]*" "$tmp/symbols" | sed "s/^${lib}_//" | newest || true)"
    [ -n "$need" ] || continue
    if [ "$(printf '%s\n%s\n' "$need" "$floor" | newest)" != "$floor" ]; then
      echo "::error::$module needs ${lib}_$need, newer than the ${lib}_$floor floor"
      bad=1
    fi
    summary="$summary ${lib}_$need"
  done
  echo "$module:${summary:- no versioned glibc/libstdc++ symbols}"
done < "$tmp/modules"

[ "$checked" -gt 0 ] || [ "$bad" -ne 0 ] || {
  echo "::error::no Linux native module found under $dir"
  exit 1
}
exit "$bad"
