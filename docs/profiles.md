# Profiles

A profile is one isolated agent login served by the relay — a separate
account for work and personal, say, or one per client. It is not a new OS
user: it's a different `$HOME` that the relay spawns the agent under, so
each profile gets its own agent configuration directory and its own
credentials while sharing one machine and one relay installation.

Every relay serves at least one profile. The first one is whatever you
created during [self-hosting](./self-hosting.md#creating-your-first-profile).

## Adding another

**1. Log the new account in, once, out of band.** On the relay machine:

```bash
HOME=/path/to/new/home claude login
```

This step is deliberately manual and outside the app. There is no in-app
login flow: the relay never holds a credential of its own, it inherits one
that already exists on disk.

**2. Create the profile.** Either from the client — profile switcher →
**add profile**, give it a label and that same path, then **Check** to
confirm the login was picked up before creating — or from the command line,
which is what that dialog calls behind the scenes:

```bash
~/.local/share/anywh/infra/systemd/add-profile.sh work \
  --relay-host <address> --home /path/to/new/home
```

See [`infra/systemd/README.md`](../infra/systemd/README.md) for the full set
of flags and how the systemd instance per profile works.

That is the whole of it. Profiles sync automatically: any other device
already pointed at the same relay machine picks the new one up on its next
sync — nothing to import, nothing to copy between devices.

## Where it all lives

Everything stays on the relay machine:

| Path | What |
|---|---|
| `~/.config/anywh/profiles.json` | The registry: ids, labels and colours |
| `~/.config/anywh/env/<profile>.env` | Per-profile settings — `RELAY_HOST`, `RELAY_PORT`, `RELAY_HOME_OVERRIDE`, and the rest of [Configuration](./configuration.md). The address a profile advertises lives here, not in the registry. |
| `~/.config/anywh/themes/*.json` | Custom themes, host-wide — see [Themes](./themes.md) |

Creating or syncing a profile never sends anything to a third party. Each
profile runs as its own systemd instance (`anywh-relay@<profile>`) on its
own port, so one profile restarting or crashing leaves the others alone.
