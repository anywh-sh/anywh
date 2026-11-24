import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/**
 * "Default app folder" for a profile — used as the initial cwd of a new
 * session and as the fallback when `GET /fs/list` doesn't receive `path`.
 * Before this function existed, the fallback for the personal profile
 * (without `homeOverride`) was the relay process's `process.cwd()` — in
 * practice anywh's own source code folder (the systemd unit's
 * `WorkingDirectory`), not the user's actual $HOME. `homedir()` is the
 * correct fallback.
 */
export function defaultCwd(homeOverride: string | undefined): string {
  return homeOverride ?? homedir();
}

/** Where one profile keeps the folders the relay itself writes. */
export interface ProfileDataDirs {
  readonly root: string;
  readonly rooms: string;
  readonly bots: string;
  /** Whether the root is this profile's alone (`RELAY_DATA_DIR`), not the
   * `<home>/.anywh` it falls back to. */
  readonly ownRoot: boolean;
}

/**
 * The profile's data root and the folders under it. A profile created with
 * its own config root gets `RELAY_DATA_DIR` (that root); any other keeps
 * `<its $HOME>/.anywh`, where its files always were. Profiles that share the
 * real `$HOME` share `~/.anywh`, so a new per-profile folder the relay writes
 * goes here, under `root` — never at a fixed `~/.anywh/<name>`, which every
 * such profile would share. A feature's own variable
 * (`RELAY_ROOM_CONTEXT_DIR`, `RELAY_BOT_DIR`) still wins, for tests and
 * relays run by hand.
 */
export function profileDataDirs(env: NodeJS.ProcessEnv, homeOverride: string | undefined): ProfileDataDirs {
  const root = env.RELAY_DATA_DIR || join(defaultCwd(homeOverride), ".anywh");
  return {
    root,
    rooms: env.RELAY_ROOM_CONTEXT_DIR || join(root, "rooms"),
    bots: env.RELAY_BOT_DIR || join(root, "bots"),
    ownRoot: Boolean(env.RELAY_DATA_DIR),
  };
}

/**
 * Resolves a path this relay ships alongside its own code, in whichever of
 * the two shapes it's currently running as: a script file on disk — dev's
 * `tsx` (`src/`) or the Linux tarball's `dist/` — where the target sits at
 * `devSegments` relative to *this* file; or a Node SEA binary (the macOS
 * Homebrew build), where the whole relay is one bundled file with no
 * `import.meta.url` worth resolving against, and the same target instead
 * ships flat next to the binary itself, at `seaSegments`.
 */
export function resolveShipped(fromFileUrl: string, devSegments: string, seaSegments: string): string {
  if (isSea()) {
    return resolve(dirname(process.execPath), seaSegments);
  }
  return resolve(dirname(fileURLToPath(fromFileUrl)), devSegments);
}
