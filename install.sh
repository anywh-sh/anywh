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
# description of a correct run. So the default is now the app, and the relay
# is one flag away.
#
# Routing, in order:
#
#   --app                     the app, explicitly — even with no display.
#   --relay-only              the relay, explicitly.
#   a relay flag              the relay, implicitly: --profile-id,
#                             --profile-label, --relay-host, --profile-home,
#                             --mode, --no-profile, --porcelain. Nothing that
#                             asks for a profile, or for the relay
#                             installer's own progress protocol, can mean
#                             anything but the relay, and
#                             this is what keeps every documented command
#                             working verbatim — the README's, the landing
#                             page's, homebrew-tap's caveats, and the one
#                             the app's own first-run wizard runs.
#   none of the above         the app where there is a graphical session to
#                             show it in, the relay where there isn't. A box
#                             reached over ssh is a relay box; a laptop is
#                             not. Whichever it picks, it says so in one
#                             line — silence about which half got installed
#                             is the whole bug this script exists to fix.
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

# Shared with install-relay.sh on purpose: one machine, one anywh directory,
# with the app beside the relay rather than in a tree of its own.
INSTALL_DIR="${ANYWH_INSTALL_DIR:-$HOME/.local/share/anywh}"

# Where assets are fetched from. Only set by tests (serving a checkout's own
# files from localhost) and by a mirror; the default is GitHub's own release
# download URLs, chosen below once the version is known.
RELEASE_BASE_URL="${ANYWH_RELEASE_BASE_URL:-}"

err() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage: install.sh [--app | --relay-only] [--version <tag>] [--no-launch]

  With no flags: installs the desktop app where there is a graphical
  session, and the relay where there isn't.

  --app                  Install the desktop app and open it, even with no
                         display detected.
  --relay-only           Install the relay: the headless service that runs
                         your agent on this machine. Implied by any of the
                         profile flags below.
  --version <tag>        Install that release instead of the latest.
                         Accepts "v0.1.6" or "0.1.6".
  --no-launch            Don't open the app once it is installed.

  Passed straight through to the relay installer, each implying
  --relay-only: --profile-id, --profile-label, --relay-host, --profile-home,
  --mode, --no-profile, --porcelain. See
  https://github.com/${REPO}/blob/main/docs/self-hosting.md for what each
  one does.
USAGE
}

# --- 1. flags --------------------------------------------------------------
# Every argument that isn't one of this script's own is handed back to the
# delegate untouched, in its original order (shift off the front, append to
# the back — after one full pass "$@" is what it was, minus ours).
route=auto
launch=1
VERSION=""
capture_version=0

imply_relay() {
  if [ "$route" = auto ]; then route=relay; fi
}

remaining=$#
while [ "$remaining" -gt 0 ]; do
  arg="$1"
  shift
  remaining=$((remaining - 1))
  # Consumed, not forwarded: both halves take a version, so this script
  # reads it and hands it back to the relay half on delegation.
  if [ "$capture_version" -eq 1 ]; then
    VERSION="$arg"
    capture_version=0
    continue
  fi
  case "$arg" in
    --app)
      route=app
      continue
      ;;
    --relay-only)
      route=relay
      continue
      ;;
    --no-launch)
      launch=0
      continue
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --version)
      capture_version=1
      continue
      ;;
    --version=*)
      VERSION="${arg#--version=}"
      continue
      ;;
    --profile-id | --profile-id=* | --profile-label | --profile-label=* | --relay-host | --relay-host=* | --profile-home | --profile-home=* | --mode | --mode=* | --no-profile | --porcelain)
      imply_relay
      ;;
  esac
  set -- "$@" "$arg"
done

[ "$capture_version" -eq 0 ] || err "--version needs a value"

# --- 2. route --------------------------------------------------------------
# A graphical session is the whole question: DISPLAY or WAYLAND_DISPLAY is
# what every GUI toolkit looks at, so "can this machine show a window" and
# "will the app the script just opened appear" are the same test. A Mac is
# never asked — a headless Mac is rare enough that the flag is the better
# answer for it.
os="$(uname -s)"
if [ "$route" = auto ]; then
  case "$os" in
    Darwin) route=app ;;
    Linux)
      if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
        route=app
      else
        route=relay
        echo "No graphical session detected — installing the relay, not the app."
        echo "Pass --app to install the desktop app here anyway."
        echo
      fi
      ;;
    *) route=relay ;;
  esac
fi

# --- 3. the relay: delegate ------------------------------------------------
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

tmp=""
cleanup() {
  [ -n "$tmp" ] && rm -rf "$tmp"
}
trap cleanup EXIT

# download_verified <asset> <destination>
# Every download in this script goes through here: fetch, then check the
# bytes against the release's own SHA256SUMS before anything is run or
# installed. Same guarantee install-relay.sh gives its tarball.
download_verified() {
  asset="$1"
  dest="$2"
  [ -n "$tmp" ] || tmp="$(mktemp -d)"
  # Downloaded into a scratch subdirectory rather than straight into $tmp:
  # one caller's destination *is* a path in $tmp, and `mv` onto itself is an
  # error, not a no-op.
  mkdir -p "$tmp/dl"

  curl -fsSL "$base_url/$asset" -o "$tmp/dl/$asset" ||
    err "couldn't download $asset — check that the release exists and ships that asset: $base_url"

  if [ ! -f "$tmp/SHA256SUMS" ]; then
    curl -fsSL "$base_url/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
      err "couldn't download SHA256SUMS from $base_url"
  fi

  expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] ||
    err "checksum for $asset not found in SHA256SUMS — the release may still be publishing, try again shortly"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/dl/$asset" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$tmp/dl/$asset" | cut -d' ' -f1)"
  fi
  [ "$expected" = "$actual" ] ||
    err "checksum mismatch for $asset (expected $expected, got $actual)"

  mv "$tmp/dl/$asset" "$dest"
}

# Resolved once, here, because both halves address a release the same way:
# the unversioned asset name through GitHub's `releases/latest/download`
# redirect (no API call, no jq on a bare box), or the same name under a
# pinned tag. Releases published before those unversioned names existed
# can't be pinned this way, which is a 404 with a message, not a silent
# wrong install.
if [ -n "$VERSION" ]; then
  version="${VERSION#v}"
  base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/download/v${version}}"
else
  base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
fi

if [ "$route" = relay ]; then
  if [ -n "$VERSION" ]; then set -- --version "$VERSION" "$@"; fi

  if [ -n "$script_dir" ] && [ -f "$script_dir/$RELAY_SCRIPT" ]; then
    if [ -x "$script_dir/$RELAY_SCRIPT" ]; then
      exec "$script_dir/$RELAY_SCRIPT" "$@"
    fi
    exec sh "$script_dir/$RELAY_SCRIPT" "$@"
  fi

  tmp="$(mktemp -d)"
  # The script is about to run as this user, so it gets the same treatment
  # the relay tarball already gets rather than being trusted for having
  # arrived over TLS. Always from `latest`, never from a pinned tag: --version
  # picks which relay is installed, not which installer installs it, exactly
  # as it did when there was one script.
  base_url="${RELEASE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
  download_verified "$RELAY_SCRIPT" "$tmp/$RELAY_SCRIPT"

  # Run, don't exec: the EXIT trap is what removes the temp directory, and
  # exec would replace this shell before it could fire. The delegate's exit
  # status is this script's own — a caller parsing --porcelain must see the
  # same last line and the same status it saw when there was one script.
  set +e
  sh "$tmp/$RELAY_SCRIPT" "$@"
  status=$?
  set -e
  exit "$status"
fi

# --- 4. the app ------------------------------------------------------------
[ $# -eq 0 ] || err "unknown option: $1 (see --help)"

arch="$(uname -m)"
case "$os" in
  Linux)
    case "$arch" in
      x86_64) target="linux-x64" ;;
      aarch64 | arm64) target="linux-arm64" ;;
      *) err "unsupported Linux architecture: $arch" ;;
    esac
    app_asset="anywh-${target}.AppImage"
    ;;
  Darwin)
    case "$arch" in
      arm64) target="darwin-arm64" ;;
      x86_64) target="darwin-x64" ;;
      *) err "unsupported macOS architecture: $arch" ;;
    esac
    app_asset="anywh-${target}.app.tar.gz"
    ;;
  *) err "the anywh app doesn't ship for $os — on Windows, download the installer from https://github.com/${REPO}/releases/latest" ;;
esac

# Which release "latest" actually resolved to, recorded below for the
# install-source marker. A pinned --version already names it; otherwise the
# unversioned URL 302s straight to the versioned one before the second hop
# hands off to a signed, tag-free CDN blob URL, so a single un-followed HEAD
# is enough to read it — no API call, no rate limit.
resolved_version="${VERSION#v}"
if [ -z "$resolved_version" ]; then
  redirect_location="$(curl -fsSI "$base_url/$app_asset" 2>/dev/null | tr -d '\r' | grep -i '^location:' | head -1)"
  resolved_version="$(printf '%s\n' "$redirect_location" | sed -n 's#.*/releases/download/v\([^/]*\)/.*#\1#p')"
fi

# Written by this script only, after the atomic rename into place has
# succeeded — never staged, never written on failure. The app treats a
# missing or malformed marker as "unknown, not updatable", which is already
# the common case for the installs that predate this file, so a half-written
# one costs nothing beyond what "no marker" already costs.
write_install_marker() {
  channel="$1"
  exec_path="$2"
  marker_dir="$INSTALL_DIR/app"
  mkdir -p "$marker_dir"
  cat > "$marker_dir/install-source.json" <<MARKER
{
  "version": 1,
  "method": "install.sh",
  "channel": "$channel",
  "path": "$exec_path",
  "installedVersion": "$resolved_version",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
MARKER
}

# Never replace a bundle while it is running, and never quietly kill an app
# somebody is using. On macOS the two would collide: the running process
# reads from the bundle being swapped under it. On Linux a rename leaves the
# running process on its old inode, so the replace is safe and only the
# launch has to be skipped.
app_is_running() {
  command -v pgrep >/dev/null 2>&1 && pgrep -x anywh >/dev/null 2>&1
}

echo "Installing the anywh app for $target..."

if [ "$os" = "Darwin" ]; then
  # /Applications when it is writable, the user's own when it isn't: a
  # script arriving through a pipe has no business prompting for a password,
  # and ~/Applications is a first-class location Spotlight and Launchpad
  # both index.
  dest_dir="/Applications"
  [ -w "$dest_dir" ] || dest_dir="$HOME/Applications"
  installed="$dest_dir/anywh.app"

  if [ -e "$installed" ] && app_is_running; then
    err "anywh is running from $installed — quit it and run this again (replacing a bundle underneath a running app corrupts it)"
  fi

  tmp="${tmp:-$(mktemp -d)}"
  staging="$tmp/stage"
  mkdir -p "$staging" "$dest_dir"
  download_verified "$app_asset" "$tmp/app.tar.gz"
  tar xzf "$tmp/app.tar.gz" -C "$staging" ||
    err "couldn't extract $app_asset (disk full, or a damaged archive)"
  [ -d "$staging/anywh.app" ] ||
    err "$app_asset doesn't contain anywh.app — the previous install, if any, was left untouched"

  # Looked at before it is destroyed: anything at that path that isn't one
  # of our bundles is somebody else's file, and this script does not get to
  # delete it.
  if [ -e "$installed" ]; then
    [ -f "$installed/Contents/MacOS/anywh" ] ||
      err "$installed exists but isn't an anywh bundle — move it aside and run this again"
    rm -rf "$installed"
  fi
  mv "$staging/anywh.app" "$installed"

  # Gatekeeper's quarantine flag is set by whatever downloaded the file, and
  # curl doesn't set it — so this is belt and braces for the day an asset
  # arrives some other way. The app is not signed yet; this path is the one
  # that doesn't make the user notice.
  xattr -dr com.apple.quarantine "$installed" 2>/dev/null || true

  write_install_marker "app-bundle" "$installed/Contents/MacOS/anywh"

  launch_target="$installed"
  echo "Installed to $installed"
else
  app_dir="$INSTALL_DIR/app"
  bin_dir="$HOME/.local/bin"
  desktop_dir="$HOME/.local/share/applications"
  icon_dir="$HOME/.local/share/icons/hicolor/256x256/apps"
  appimage="$app_dir/anywh.AppImage"
  mkdir -p "$app_dir" "$bin_dir" "$desktop_dir" "$icon_dir"

  # Sweep what a previous run died inside, the way install-relay.sh does for
  # its own staging trees: each run only ever cleans up directories named
  # after its own pid, so a crash between download and rename leaves one
  # nothing would otherwise collect.
  for leftover in "$app_dir"/.staging.* "$app_dir"/.unpack.*; do
    [ -e "$leftover" ] && rm -rf "$leftover"
  done

  # Staged inside the destination, not in /tmp: a rename within one
  # filesystem is atomic, one across filesystems degrades to a copy and
  # reopens the window where the file on disk is half an app. Same reasoning
  # install-relay.sh spells out for the relay tree.
  staging="$app_dir/.staging.$$"
  rm -rf "$staging"
  mkdir "$staging"
  download_verified "$app_asset" "$staging/anywh.AppImage"
  chmod +x "$staging/anywh.AppImage"
  download_verified "anywh-icon.png" "$staging/anywh.png"

  mv "$staging/anywh.png" "$icon_dir/anywh.png"
  mv "$staging/anywh.AppImage" "$appimage"
  rm -rf "$staging"

  # An AppImage needs FUSE 2 to mount itself, and the desktops most likely
  # to be running this (Ubuntu 24.04, Fedora) stopped shipping it years ago.
  # The runtime's own --appimage-extract doesn't need FUSE, so the fallback
  # is to unpack once at install time and point the launcher at AppRun. Done
  # here rather than left for the first double-click, which would otherwise
  # fail with a dlopen error no user can act on.
  extracted="$app_dir/anywh.AppDir"
  rm -rf "$extracted"
  # ANYWH_APPIMAGE_NO_FUSE=1 forces the unpack path. The fallback is the
  # branch most users on a current desktop will actually take, and a CI
  # runner that happens to ship libfuse2 would never exercise it otherwise.
  has_fuse=0
  if [ "${ANYWH_APPIMAGE_NO_FUSE:-0}" = "1" ]; then
    has_fuse=0
  elif command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q "libfuse\.so\.2"; then
    has_fuse=1
  else
    for libdir in /lib /usr/lib /lib64 /usr/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu; do
      if [ -e "$libdir/libfuse.so.2" ]; then
        has_fuse=1
        break
      fi
    done
  fi

  if [ "$has_fuse" -eq 1 ]; then
    exec_target="$appimage"
  else
    echo "libfuse2 isn't installed — unpacking the AppImage instead of mounting it."
    unpack="$app_dir/.unpack.$$"
    rm -rf "$unpack"
    mkdir "$unpack"
    (cd "$unpack" && "$appimage" --appimage-extract >/dev/null 2>&1) ||
      err "couldn't unpack the AppImage, and libfuse2 isn't available to run it as-is — install libfuse2 (Debian/Ubuntu: 'sudo apt install libfuse2') and run this again"
    [ -x "$unpack/squashfs-root/AppRun" ] ||
      err "the unpacked AppImage has no AppRun — the download may be damaged"
    mv "$unpack/squashfs-root" "$extracted"
    rm -rf "$unpack"
    exec_target="$extracted/AppRun"
  fi

  ln -sf "$exec_target" "$bin_dir/anywh"

  # Written here rather than lifted out of the AppImage: reading the one
  # inside means mounting or unpacking a squashfs to get a dozen lines, and
  # every field that matters (the absolute Exec and Icon, the anywh:// scheme
  # the app registers through tauri-plugin-deep-link) has to be rewritten
  # for this machine anyway.
  cat > "$desktop_dir/sh.anywh.client.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=anywh
Comment=Run your coding agent from any device
Exec=$exec_target %U
Icon=$icon_dir/anywh.png
Terminal=false
Categories=Development;Utility;
StartupWMClass=anywh
MimeType=x-scheme-handler/anywh;
DESKTOP

  # Both are caches: without them the entry still works from a menu that
  # rescans, and the anywh:// handler registers on the next login. Neither is
  # worth failing an otherwise complete install over.
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true

  if [ "$has_fuse" -eq 1 ]; then
    write_install_marker "appimage" "$exec_target"
  else
    write_install_marker "appdir" "$exec_target"
  fi

  launch_target="$exec_target"
  echo "Installed to $app_dir"

  case ":${PATH}:" in
    *":$bin_dir:"*) ;;
    *) echo "Note: $bin_dir isn't on your PATH, so the 'anywh' command won't resolve until you add it." ;;
  esac
fi

# --- 5. open it ------------------------------------------------------------
# The point of the whole change: the command ends with software on screen,
# not with instructions. An instance already running is left alone — a second
# window is not what re-running an installer should produce.
if [ "$launch" -eq 0 ]; then
  :
elif app_is_running; then
  echo "anywh is already running — quit and reopen it to pick up this version."
elif [ "$os" = "Darwin" ]; then
  open -a "$launch_target" || echo "Couldn't open the app automatically — it's in $launch_target"
elif command -v setsid >/dev/null 2>&1; then
  setsid "$launch_target" >/dev/null 2>&1 &
else
  nohup "$launch_target" >/dev/null 2>&1 &
fi

cat <<NEXT

anywh is installed. The app's first screen asks where your agent runs:

  - on this machine        pick "Set up on this machine" and it installs
                           the relay for you, no terminal needed
  - on another machine     install the relay there with
                           curl -fsSL https://anywh.sh/install | sh -s -- --relay-only
NEXT
