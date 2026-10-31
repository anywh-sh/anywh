# Windows and WSL2

On Windows, the anywh app runs natively and the relay runs inside WSL2. The
relay needs a POSIX shell, systemd and your agent CLI, and WSL2 gives it all
three. This page takes a Windows machine from nothing to a relay the app can
connect to.

You need Windows 10 (version 2004 or newer) or Windows 11. Everything below
runs in the Linux shell, except step 1.

## 1. Install WSL2 with a distribution

In PowerShell opened as administrator:

```powershell
wsl --install
```

This enables WSL2 and installs Ubuntu. Restart when asked, then open
**Ubuntu** from the Start menu and create your Linux user. If you already
have WSL, check that the distribution is on version 2:

```powershell
wsl --list --verbose
```

The `VERSION` column must say `2`. To convert one, run
`wsl --set-version <name> 2`.

Official reference: [Install WSL](https://learn.microsoft.com/windows/wsl/install).

## 2. Turn on systemd

The relay runs as a systemd user service, so it comes back on its own after
a restart. Recent WSL releases ship with systemd off by default. In the
Ubuntu shell:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'CONF'
[boot]
systemd=true
CONF
```

If the file already exists, add the `[boot]` section to it instead of
overwriting it. Then, back in PowerShell:

```powershell
wsl --shutdown
```

Open Ubuntu again and check:

```bash
systemctl --user status
```

Any status output, including `degraded`, means systemd is running. An error
about not being able to connect to the bus means it is not.

## 3. Install Node.js

The relay needs Node.js 20.12 or newer, and the installer stops before
downloading anything if it is missing or too old. Check what you have:

```bash
node --version
```

If it is missing or older, install a current version with
[nvm](https://github.com/nvm-sh/nvm) or the options on
[nodejs.org](https://nodejs.org/en/download). Ubuntu's own `nodejs` package
is often too old.

## Install an agent

The relay does not ship an agent. It drives the agent CLI installed in the
same WSL2 distribution and uses that CLI's login, so install and log in
inside the Ubuntu shell, not in Windows. A Windows install of Claude Code or
Codex is not visible to the relay.

Install at least one:

**Claude Code**

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude
```

Run `claude` once and follow the login prompt. Official reference:
[Claude Code setup](https://code.claude.com/docs/en/setup).

**Codex**

```bash
npm install -g @openai/codex
codex login
```

Official reference: [Codex CLI](https://developers.openai.com/codex/cli).

Check that the shell finds it before moving on:

```bash
command -v claude codex
```

## 4. Install the relay

In the Ubuntu shell:

```bash
curl -fsSL https://anywh.sh/install | sh -s -- --profile-id default --relay-host 127.0.0.1
```

The script downloads the latest release, verifies its checksum, registers the
systemd user service and creates the first profile. It stops with a clear
message if Node.js or systemd is missing. The other options, and what the
script does step by step, are in [Self-hosting](./self-hosting.md).

`127.0.0.1` keeps the relay on the machine itself. WSL2 forwards that port to
Windows, so the app reaches it at `127.0.0.1:8765` without opening anything to
your network. To use it from your phone as well, see
[Remote access](./remote-access.md).

## 5. Connect the app

Install the Windows app from the
[latest release](https://github.com/anywh-sh/anywh/releases/latest) (`.msi`
or `.exe`) and open it. On the first-run screen choose *Connect to a machine
that already runs the relay* and use the address from step 4. The pairing
steps are in [Pairing](./pairing.md).

## Troubleshooting

- **`systemd --user isn't reachable`** from the installer: systemd is off.
  Redo step 2 and make sure you ran `wsl --shutdown` afterwards.
- **The app cannot connect:** in the Ubuntu shell, run
  `systemctl --user status anywh-relay@default`. If it is not active, start
  it with `systemctl --user start anywh-relay@default`.
- **Agent shows as not found:** it was installed on the Windows side, or in a
  different distribution. Install it in the same distribution as the relay.
