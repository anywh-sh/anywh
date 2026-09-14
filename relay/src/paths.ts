import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
