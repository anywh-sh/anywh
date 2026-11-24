#!/bin/bash
# Builds the tmux the macOS app ships beside the relay's SEA binary: a stock
# Mac has no tmux, and the terminal panel needs one (relay/src/host/
# terminalSession.ts). darwin-arm64 only; run on a Mac with the Xcode command
# line tools.
#
#   bash relay/sea-build/build-tmux.sh <out dir>
#
# Writes <out dir>/tmux and the three licenses under <out dir>/licenses/.
# libevent and utf8proc are linked statically, so the binary depends only on
# system libraries (libSystem, libncurses, libresolv).
#
# Bumping tmux: its client/server PROTOCOL_VERSION must stay the same, or the
# terminals a user had open before the app update become unreachable until
# their tmux server is killed.
set -euo pipefail

OUT="${1:?usage: build-tmux.sh <out dir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

LIBEVENT_VERSION=2.1.13
LIBEVENT_SHA256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC_VERSION=2.12.0
UTF8PROC_SHA256=f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111
TMUX_VERSION=3.8
TMUX_SHA256=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/prefix"
cd "$WORK"

export MACOSX_DEPLOYMENT_TARGET=11.0
# Building with a new SDK, configure finds calls that only exist on the newest
# macOS (libevent's pipe2, macOS 27) and the binary would not load on older
# ones. -Werror turns any such call into a build failure instead of a user's.
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -Werror=unguarded-availability-new"

fetch() {
  local url="$1" file="$2" sha="$3"
  curl -fsSL -o "$file" "$url"
  echo "$sha  $file" | shasum -a 256 -c -
}

fetch "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION-stable/libevent-$LIBEVENT_VERSION-stable.tar.gz" libevent.tar.gz "$LIBEVENT_SHA256"
fetch "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC_VERSION.tar.gz" utf8proc.tar.gz "$UTF8PROC_SHA256"
fetch "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" tmux.tar.gz "$TMUX_SHA256"

tar xf libevent.tar.gz
(
  cd "libevent-$LIBEVENT_VERSION-stable"
  ac_cv_func_pipe2=no ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-openssl --disable-samples --disable-libevent-regress >/dev/null
  make -j"$(sysctl -n hw.ncpu)" >/dev/null
  make install >/dev/null
)

tar xf utf8proc.tar.gz
(
  cd "utf8proc-$UTF8PROC_VERSION"
  make -j"$(sysctl -n hw.ncpu)" libutf8proc.a >/dev/null
  mkdir -p "$PREFIX/lib" "$PREFIX/include"
  cp libutf8proc.a "$PREFIX/lib/"
  cp utf8proc.h "$PREFIX/include/"
)

tar xf tmux.tar.gz
(
  cd "tmux-$TMUX_VERSION"
  # No pkg-config on a stock Mac (or runner): the flags go in directly.
  LIBEVENT_CFLAGS="-I$PREFIX/include" LIBEVENT_LIBS="$PREFIX/lib/libevent_core.a" \
  LIBUTF8PROC_CFLAGS="-I$PREFIX/include" LIBUTF8PROC_LIBS="$PREFIX/lib/libutf8proc.a" \
  CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib" \
    ./configure --enable-utf8proc --disable-jemalloc --disable-dependency-tracking >/dev/null
  make -j"$(sysctl -n hw.ncpu)" >/dev/null
  strip tmux
  cp tmux "$OUT/tmux"
)

mkdir -p "$OUT/licenses"
cp "tmux-$TMUX_VERSION/COPYING" "$OUT/licenses/tmux.txt"
cp "libevent-$LIBEVENT_VERSION-stable/LICENSE" "$OUT/licenses/libevent.txt"
cp "utf8proc-$UTF8PROC_VERSION/LICENSE.md" "$OUT/licenses/utf8proc.txt"

# Nothing but system libraries, and loadable on the deployment target.
if otool -L "$OUT/tmux" | tail -n +2 | grep -v -E '^\s+/usr/lib/'; then
  echo "error: tmux links a library outside /usr/lib" >&2
  exit 1
fi
"$OUT/tmux" -V
