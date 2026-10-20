// One agent host per profile, enforced before the host touches anything.
//
// A host's start ends every process carrying its marker and rewrites its
// registry, so a second host started by mistake for the same profile (a dev
// run next to the service, two units racing) must fail before doing either.
// The lock is taken on every key a host could clash on: its id (the marker
// its sweep matches), its data directory, and its socket path.
//
// On Linux each key is an abstract unix socket (`\0...`): binding one is
// atomic, and the kernel releases it when the process dies, so a crashed
// host never leaves a stale lock behind. The name includes the uid; it is
// still per network namespace, so two hosts of the same user in different
// namespaces (containers) do not see each other's lock. Elsewhere a lock file per key holds
// the owner's pid, created with O_EXCL; a file whose pid is gone is taken
// over (two hosts racing on a stale file there can both win — a known limit
// outside Linux).
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { isAlive } from "./processTree.js";

export class InstanceLockedError extends Error {
  constructor(key: string, detail: string) {
    super(`another agent host already holds ${key} (${detail})`);
    this.name = "InstanceLockedError";
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

/** The lock's name for `key`, per user: abstract socket names are shared by
 * every user of the machine (they live in the network namespace, not the
 * file system), so without the uid two users' `default` profiles would
 * collide, and any user could squat another's name. */
export function instanceLockName(key: string, uid: number | undefined = process.getuid?.()): string {
  return `anywh-agent-host-${createHash("sha256").update(`${uid ?? "nouid"}:${key}`).digest("hex").slice(0, 40)}`;
}

function bindAbstract(key: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new InstanceLockedError(key, "held by a live process") : error);
    });
    server.listen(`\0${instanceLockName(key)}`, () => {
      server.removeAllListeners("error");
      // Never accepts anyone: the bound name is the lock.
      server.on("connection", (socket) => socket.destroy());
      server.unref();
      resolve(server);
    });
  });
}

function takeLockFile(dir: string, key: string): () => void {
  const path = join(dir, `.${instanceLockName(key)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) {
        throw new InstanceLockedError(key, `pid ${owner}`);
      }
      unlinkSync(path);
    }
  }
  throw new InstanceLockedError(key, "lock file contended");
}

/** Takes every key or none. `lockFileDir` is where the non-Linux fallback
 * keeps its files (the host's data directory). */
export async function acquireInstanceLock(keys: readonly string[], lockFileDir: string): Promise<InstanceLock> {
  const releases: (() => Promise<void>)[] = [];
  const releaseAll = async (): Promise<void> => {
    for (const release of releases.splice(0).reverse()) await release();
  };
  try {
    for (const key of keys) {
      if (process.platform === "linux") {
        const server = await bindAbstract(key);
        releases.push(() => new Promise((resolve) => server.close(() => resolve())));
      } else {
        const release = takeLockFile(lockFileDir, key);
        releases.push(() => Promise.resolve(release()));
      }
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }
  return { release: releaseAll };
}
