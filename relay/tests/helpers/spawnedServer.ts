import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./env.js";
import { getFreePort } from "./ports.js";
import { FAKE_AGENT_BIN, FAKE_SYSTEMCTL_BIN } from "./testServer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = resolvePath(HERE, "../..");
const SERVER_ENTRY = resolvePath(RELAY_ROOT, "src/server.ts");

/** Resolves once the child itself logged that it is listening on `port` — a
 * connection to the port would also succeed against a different process that
 * holds it — and rejects if the child exits first or says nothing in time. */
function waitUntilListening(proc: ChildProcess, output: string[], port: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const listening = (): boolean => output.join("").includes(`[relay] listening on ws://127.0.0.1:${port}`);
    const timer = setInterval(check, 25);
    const deadline = Date.now() + timeoutMs;
    function finish(error?: Error): void {
      clearInterval(timer);
      proc.off("exit", onExit);
      if (error) reject(error);
      else resolveWait();
    }
    function onExit(code: number | null): void {
      finish(new Error(`relay exited (code ${code}) before listening on port ${port}:\n${output.join("")}`));
    }
    function check(): void {
      if (listening()) finish();
      else if (Date.now() > deadline) finish(new Error(`relay did not start listening on port ${port} within ${timeoutMs}ms:\n${output.join("")}`));
    }
    proc.once("exit", onExit);
    check();
  });
}

export interface SpawnedServer {
  port: number;
  proc: ChildProcess;
  /** Every line the child wrote to stdout+stderr so far — `gracefulShutdown`
   * is only observable through its own `console.log`/`console.warn`, since
   * this is a real separate process with no exports to import. */
  output: string[];
  /** Resolves with the child's own exit once it actually exits — rejects if
   * it's still alive after `timeoutMs`, printing the output collected so
   * far (the same "never a silent hang" reasoning as testServer.ts's
   * `close`). */
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  cleanup(): void;
}

/**
 * Spawns the real relay as a genuinely separate OS process (`node --import
 * tsx`, the same TypeScript loader `npm run dev` uses, but loaded into the
 * relay's own process rather than through the `tsx` CLI wrapper). Not the
 * wrapper on purpose: on SIGTERM it waits only ~30ms for the child to
 * acknowledge the signal over IPC and SIGKILLs it otherwise, exiting 143 —
 * a busy event loop right after boot (the model probes, CI's slow runners)
 * was enough to lose that race and fail `gracefulShutdown` with no bug in
 * the relay. Production runs `node dist/server.js`, no wrapper either. — required specifically for
 * `gracefulShutdown`, which calls `process.exit(0)`: the normal integration
 * tier's `startTestServer` imports `server.ts` into the *same* process
 * running the test file, and triggering a real exit there would take
 * `node:test`'s own reporting down with it. Signals sent here (`proc.kill`)
 * land on that separate process, never on the test runner's own.
 */
export async function spawnRelay(extraEnv: Record<string, string> = {}): Promise<SpawnedServer> {
  // A port is free when picked, not when the child binds it: another test
  // process may take it in between, and the child then dies on EADDRINUSE.
  // That is retried on a new port; a test that fixed its own port gets the error.
  const attempts = extraEnv.RELAY_PORT ? 1 : 3;
  for (let attempt = 1; ; attempt++) {
    const spawned = await spawnRelayOnce(extraEnv);
    try {
      await spawned.ready;
      return spawned.server;
    } catch (error) {
      spawned.server.cleanup();
      if (attempt >= attempts || !/EADDRINUSE/.test(spawned.server.output.join(""))) throw error;
    }
  }
}

async function spawnRelayOnce(extraEnv: Record<string, string>): Promise<{ server: SpawnedServer; ready: Promise<void> }> {
  const workDir = mkdtempSync(join(tmpdir(), "anywh-relay-spawn-"));
  const homeDir = join(workDir, "home");
  mkdirSync(homeDir, { recursive: true });
  const port = extraEnv.RELAY_PORT ? Number(extraEnv.RELAY_PORT) : await getFreePort();

  const proc = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    cwd: RELAY_ROOT,
    env: {
      ...cleanEnv(),
      RELAY_PORT: String(port),
      RELAY_HOST: "127.0.0.1",
      RELAY_HOME_OVERRIDE: homeDir,
      ANYWH_ENV_DIR: join(workDir, "env"),
      RELAY_SESSIONS_FILE: join(workDir, "sessions.json"),
      RELAY_BACKGROUND_JOBS_FILE: join(workDir, "background-jobs.json"),
      AGENT_BIN: FAKE_AGENT_BIN,
      SYSTEMCTL_BIN: FAKE_SYSTEMCTL_BIN,
      // Never the machine's real agent host socket (see testServer.ts).
      ANYWH_AGENT_HOST_SOCKET: join(workDir, "agent-host.sock"),
      ANYWH_SESSIONS_ROOT: join(workDir, "sessions-root"),
      // Reports waiting for a room's principal stay in its outbox unless a
      // test asks for the digest (roomDigest.test.ts sets a short window).
      RELAY_ROOM_DIGEST_WINDOW_MS: "600000",
      // Agents of one model do not wait behind the first (a test that exercises the wait asks for it).
      RELAY_ROOM_WARMUP_MS: "0",
      ...extraEnv,
    },
  });

  const output: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const ready = waitUntilListening(proc, output, port);

  const server: SpawnedServer = {
    port,
    proc,
    output,
    waitForExit(timeoutMs = 15000) {
      return new Promise((resolveExit, reject) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolveExit({ code: proc.exitCode, signal: proc.signalCode });
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`relay did not exit within ${timeoutMs}ms — output so far:\n${output.join("")}`));
        }, timeoutMs);
        proc.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolveExit({ code, signal });
        });
      });
    },
    cleanup() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      // The killed relay (or an agent process it started) may still be
      // writing into its home as the removal walks it: ENOTEMPTY, retried. A
      // temp directory that stays is no reason to fail a test that passed.
      try {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
    },
  };
  return { server, ready };
}
