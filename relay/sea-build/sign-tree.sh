#!/bin/bash
# Signs the relay tree build.mjs lays out (sea-build/dist/darwin-arm64, plus
# the tmux from build-tmux.sh) for the macOS app, before `tauri build` bundles
# it as resources: the bundler copies resources without signing them, and
# notarization rejects any unsigned Mach-O inside the app.
#
#   bash relay/sea-build/sign-tree.sh <tree> <identity>
#
# <identity> is a Developer ID ("Developer ID Application: ...") in CI, or
# `-` for an ad-hoc signature to test locally. Everything gets the hardened
# runtime (notarization requires it); the binaries inside first, the relay
# binary last, and only the relay binary gets Relay.entitlements (V8's JIT,
# loading pty.node): tmux and node-pty's helpers need none.
set -euo pipefail

TREE="${1:?usage: sign-tree.sh <tree> <identity>}"
IDENTITY="${2:?usage: sign-tree.sh <tree> <identity>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FLAGS=(--force --sign "$IDENTITY" --options runtime)
# A secure timestamp needs a real identity (and Apple's server); an ad-hoc
# signature has nothing to timestamp.
if [[ "$IDENTITY" != "-" ]]; then FLAGS+=(--timestamp); fi

# Signed as a fresh copy, then moved over the original: the kernel caches a
# file's signature by vnode, and re-signing a binary that already ran in
# place can leave the old verdict in effect (a run that fails, then passes
# with no change, or the other way round).
sign() {
  local file="$1"
  shift
  local fresh="$file.signing"
  cp "$file" "$fresh"
  codesign "${FLAGS[@]}" "$@" "$fresh"
  mv "$fresh" "$file"
}

for file in "$TREE"/node_modules/node-pty/prebuilds/darwin-arm64/* "$TREE/tmux"; do
  [[ -f "$file" ]] || { echo "error: missing $file" >&2; exit 1; }
  sign "$file"
done
sign "$TREE/anywh-relay" --entitlements "$HERE/Relay.entitlements"

codesign --verify --strict --verbose=2 "$TREE/anywh-relay"
