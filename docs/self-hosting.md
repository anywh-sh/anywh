# Self-hosting

The full install, in more detail than the one line on the front page. The
relay is the piece with choices to make — where it runs, which address it
answers on, how many profiles — so it comes first here; the app half is a
download and a launch.

If all you want is the happy path, the three steps in the
[README](../README.md#quick-start) are the short version of this page.

## Before you start

The relay does not install your agent for you, and the install script stops
rather than guessing. On the machine that will run it:

- **Node.js 20.12 or newer.** The install script checks the version and
  refuses to continue below it.
- **An agent CLI, already logged in.** The relay spawns whatever binary it
  is pointed at and inherits that login — it never holds a credential of its
  own. Log in once, out of band, before anything else.
- **Linux or Apple Silicon macOS** for the packaged relay. Intel Macs have
  no published build; on Windows, run the relay inside WSL2. The *client* is
  a separate matter and ships for Windows, macOS and Linux — its Linux
  builds need **glibc 2.35 or newer** (Ubuntu 22.04+, Debian 12+), because
  the app is a compiled binary and glibc is not forward compatible. Below
  that floor the package installs without complaining and the app then
  refuses to start, saying `version GLIBC_2.xx not found` only when it is
  launched from a terminal. The relay has no such floor: its one native
  module needs nothing newer than glibc 2.34.
- **`tmux`**, if you want the integrated terminal panel.

## One command, two halves

anywh is two programs, and one command installs whichever the machine you
run it on is for:

```bash
curl -fsSL https://anywh.sh/install | sh
```

On a machine with a graphical session that is the **desktop app**, installed
and opened. On one without — a server you reached over ssh — it is the
**relay**, the headless service that runs your agent. It prints which one it
picked, and either can be asked for by name:

| Flag | Installs |
|---|---|
| *(none)* | the app where there is a display, the relay where there isn't |
| `--app` | the app, even with no display detected |
| `--relay-only` | the relay |
| any profile flag | the relay — `--profile-id`, `--relay-host` and friends imply `--relay-only`, so every command on this page works as written |
| `--version v0.1.6` | that release instead of the latest, either half |
| `--no-launch` | skips opening the app afterwards |

The relay half lives in its own script, reachable directly at
`https://anywh.sh/install-relay`. The front door downloads and
checksum-verifies it when there is no copy beside it — which is every
`curl | sh` — and runs the sibling copy instead when there is one, so a
checkout or an unpacked release tree always runs its own.

## Installing the relay

### The install script

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --relay-only
```

It downloads the release tarball for your platform, verifies it against the
release's `SHA256SUMS`, unpacks it to `~/.local/share/anywh`, and renders a
systemd user unit so the relay survives reboots. Re-running it upgrades in
place and never touches profile state.

Override the destination with `ANYWH_INSTALL_DIR` if `~/.local/share/anywh`
isn't where you want it.

It installs the latest release by default. To pin one:

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --relay-only --version v0.1.1
```

The leading `v` is optional, and the pinned download is checksum-verified
against that release's own `SHA256SUMS` exactly like the latest one.

To go from a bare machine to a listening relay in one run, let the script
create the first profile too:

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --profile-id default --relay-host auto
```

`--relay-host` is the address other devices reach this machine on; `auto`
picks the tailnet address if there is one, otherwise the single private LAN
address, and refuses to guess when there are several. `--profile-label`,
`--profile-home` and `--mode dev` (touch no systemd, print the run command)
round it out; `--porcelain` adds machine-readable `ANYWH ...` progress lines
for a program driving the script — the desktop app's own setup uses it.
Re-running with the same flags is a no-op for the profile and never
restarts a running relay.

On macOS the script installs the tree and stops there: it has no launchd
unit to offer, so the service comes from the Homebrew formula instead
(`brew install anywh-sh/tap/anywh-relay`), and a profile requested on macOS
is provisioned in dev mode.

### From source

Useful when you're changing the relay, not just running it.

```bash
cd relay
npm install
cp .env.example .env    # optional — see Configuration
npm run build
npm start               # or `npm run dev` to run from TypeScript directly
```

It listens on `127.0.0.1:8765` unless told otherwise. Every setting is
optional and documented in [Configuration](./configuration.md); the common
one is `AGENT_BIN`, needed when your agent CLI isn't resolvable by bare name
from the relay's own PATH.

Running it as a service instead of from a shell is covered in
[`infra/systemd/README.md`](../infra/systemd/README.md).

## Installing the client

### The install script

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --app
```

`--app` is only needed where the script would otherwise pick the relay — on
a desktop, the bare command already does this. Everything lands under your
own home directory; nothing asks for a password.

On **Linux** it takes the AppImage:

| What | Where |
|---|---|
| the app | `~/.local/share/anywh/app/anywh.AppImage` |
| a launcher on `PATH` | `~/.local/bin/anywh` |
| the menu entry | `~/.local/share/applications/sh.anywh.client.desktop` |
| its icon | `~/.local/share/icons/hicolor/256x256/apps/anywh.png` |

`ANYWH_INSTALL_DIR` moves the first of those, same as for the relay. An
AppImage needs FUSE 2 to mount itself and several current distributions no
longer ship it; when `libfuse2` is missing the installer unpacks the image
to `~/.local/share/anywh/app/anywh.AppDir` once and points the launcher at
its `AppRun`, rather than leaving you a `dlopen` error on first launch.

On **macOS** it takes the `.app` bundle, into `/Applications` when that is
writable and `~/Applications` when it isn't. It refuses to replace a bundle
that is currently running — quit the app first — and refuses to delete
anything at that path that isn't an anywh bundle.

Either way it opens the app when it's done, unless you pass `--no-launch`.
An instance already running is left alone, with a note to restart it.

### Prebuilt

[Download the latest release](https://github.com/anywh-sh/anywh/releases/latest)
and install it like any other app: `.msi`/`.exe` on Windows, `.dmg` on
macOS, `.AppImage`/`.deb`/`.rpm` on Linux. This is the only way in on
Windows, where there is no POSIX shell for the script to run in, and it is
the right way if you'd rather your package manager owned the install: the
`.deb` and `.rpm` are what the script deliberately doesn't use, since it
would have to ask for a password to install them.

### From source

Needs the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS — a Rust toolchain plus platform system libraries — and a Go
toolchain, which the build uses for a bundled helper binary and invokes for
you. Any Go from 1.21 on works; the exact version the helper pins is fetched
automatically.

```bash
cd client
npm install
npm run tauri dev     # full desktop app
npm run dev           # Vite only, in a browser, without Tauri APIs
```

`npm run dev` alone needs neither Go nor Rust — it serves the frontend in a
browser without Tauri APIs, which is enough for pure UI work.

## Pointing the client at your relay

A fresh client opens on a first-run screen. On Linux or macOS it first looks
at the machine it is on: a relay already installed here is recognised and
its profiles adopted, and *Set up on this machine* installs one if there is
none. Everywhere, two more ways in: connect to a machine that already runs
the relay, by address and port, or paste a pairing code. Both are also
available later, once a profile exists.

**Pairing code or deep link.** The right answer when the relay isn't
directly addressable — behind NAT, or on a tailnet. In the profile switcher,
**add remote machine**, then paste a `CODE@host` pairing code; an
`anywh://import-profile` deep link does the same with nothing typed. Both
require the relay side to implement the two endpoints in the
[pairing protocol](./pairing.md). The client hardcodes no server.

**`localStorage` override.** Desktop only, since it needs DevTools, but it
needs no rebuild. In the console:

```js
localStorage.setItem("anywh:profiles", JSON.stringify([
  { id: "default", label: "Default", host: "127.0.0.1", relayPort: 8765 },
]));
```

then reload.

## Creating your first profile

A profile is the agent login the relay serves — you need at least one before
there is anything to talk to.

### In the app

With nothing set up yet, the client opens on a first-run screen. On Linux or
macOS it looks at the machine first — no network, no install — and opens one
of three doors:

- A relay with profiles is already here: they are listed and adopted in one
  click. Nothing is installed or created.
- A relay is installed but has no profile: you land on the wizard's address
  step and only the profile is created.
- Nothing here: *Set up on this machine* drives the same install a terminal
  user would, from inside the app, in four steps — prerequisites (an agent
  CLI logged in, plus Node.js 20.12+ and a user service manager on Linux, or
  Homebrew on macOS), the profile's name and the address other devices reach
  this machine on (your tailnet address is recommended when there is one;
  loopback is allowed and warned about), the install itself with its log,
  and a verification that the new profile answers. Closing the window
  mid-install asks whether to let it finish in the background; the next
  launch picks it up where it is.

The other two paths — connect to a machine that already runs the relay, or
paste a pairing code — are how a second device joins. Later profiles are
added from the profile switcher.

### From the command line

The same provisioning the app performs, if you would rather do it on the
machine itself — or if you are setting the relay up headless, before any
client has ever connected to it. The installer does both steps in one run:

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --profile-id default \
  --relay-host <the address other devices will reach this machine on>
```

With the relay already installed, `add-profile.sh` creates a profile on its
own (`--resume` finishes one a previous run left half-done):

```bash
~/.local/share/anywh/infra/systemd/add-profile.sh default \
  --relay-host <the address other devices will reach this machine on>
```

`--relay-host` is required for the very first profile, because there is no
existing profile to copy a default from — `auto` picks the tailnet address,
else the single LAN address, and refuses to guess. Use the machine's LAN IP, or its address on
your private network if you will connect from outside the house — see
[Remote access](./remote-access.md).

Running more than one agent login on the same machine is
[Profiles](./profiles.md), and
[`infra/systemd/README.md`](../infra/systemd/README.md) covers the full set
of flags and the systemd instance behind each profile.

## iOS

```bash
cd client
npm run ios:device                  # Simulator, or prompts for a connected device
npm run ios:device -- "My iPhone"   # a specific physical device
```

iOS has no DevTools, so the first-run screen (or pairing) is the way to
point an iOS build at a relay. If you always target the same device, drop a
gitignored `*.local.sh` wrapper in `client/` instead of retyping the name.

## Next

- [Configuration](./configuration.md) — every setting on both sides
- [Remote access](./remote-access.md) — reaching the relay from outside your LAN
- [Profiles](./profiles.md) — more than one agent login on one machine
- [Themes](./themes.md) — writing and sharing a theme
