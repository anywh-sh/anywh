# Self-hosting

The full install, in the order you actually do it: get the relay running on
the machine your agent lives on, then point a client at it.

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

## Installing the relay

### The install script

```bash
curl -fsSL https://anywh.sh/install | sh
```

It downloads the release tarball for your platform, verifies it against the
release's `SHA256SUMS`, unpacks it to `~/.local/share/anywh`, and renders a
systemd user unit so the relay survives reboots. Re-running it upgrades in
place and never touches profile state.

Override the destination with `ANYWH_INSTALL_DIR` if `~/.local/share/anywh`
isn't where you want it.

It installs the latest release by default. To pin one:

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --version v0.1.1
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

### Prebuilt

[Download the latest release](https://github.com/anywh-sh/anywh/releases/latest)
and install it like any other app: `.msi`/`.exe` on Windows, `.dmg` on
macOS, `.AppImage`/`.deb`/`.rpm` on Linux.

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

A fresh client opens on a first-run screen. On Linux it first looks at the
machine it is on: a relay already installed here is recognised and its
profiles adopted, and *Set up on this machine* installs one if there is
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

With nothing set up yet, the client opens on a first-run screen. On Linux
it looks at the machine first — no network, no install — and opens one of
three doors:

- A relay with profiles is already here: they are listed and adopted in one
  click. Nothing is installed or created.
- A relay is installed but has no profile: you land on the wizard's address
  step and only the profile is created.
- Nothing here: *Set up on this machine* runs the same `install.sh` a
  terminal user would, from inside the app, in four steps — prerequisites
  (Node.js 20.12+, your agent CLI logged in, a user service manager), the
  profile's name and the address other devices reach this machine on (your
  tailnet address is recommended when there is one; loopback is allowed and
  warned about), the install itself with its log, and a verification that
  the new profile answers. Closing the window mid-install asks whether to
  let it finish in the background; the next launch picks it up where it is.

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
