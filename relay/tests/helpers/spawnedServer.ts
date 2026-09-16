import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_AGENT_BIN, FAKE_SYSTEMCTL_BIN } from "./testServer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = resolvePath(HERE, "../..");
const TSX_BIN = resolvePath(RELAY_ROOT, "node_modules/.bin/tsx");
const SERVER_ENTRY = resolvePath(RELAY_ROOT, "src/server.ts");

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const attempt = () => {
      const socket = netConnect({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolveWait();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`relay did not start listening on port ${port} within ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 25);
      });
    };
    attempt();
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
 * Spawns the real relay as a genuinely separate OS process (via the same
 * `tsx` this project's own `npm run dev` uses) — required specifically for
 * `gracefulShutdown`, which calls `process.exit(0)`: the normal integration
 * tier's `startTestServer` imports `server.ts` into the *same* process
 * running the test file, and triggering a real exit there would take
 * `node:test`'s own reporting down with it. Signals sent here (`proc.kill`)
 * land on that separate process, never on the test runner's own.
 */
export async function spawnRelay(extraEnv: Record<string, string> = {}): Promise<SpawnedServer> {
  const workDir = mkdtempSync(join(tmpdir(), "anywh-relay-spawn-"));
  const homeDir = join(workDir, "home");
  mkdirSync(homeDir, { recursive: true });
  const port = await getFreePort();

  const proc = spawn(TSX_BIN, [SERVER_ENTRY], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_HOST: "127.0.0.1",
      RELAY_HOME_OVERRIDE: homeDir,
      ANYWH_ENV_DIR: join(workDir, "env"),
      RELAY_SESSIONS_FILE: join(workDir, "sessions.json"),
      RELAY_BACKGROUND_JOBS_FILE: join(workDir, "background-jobs.json"),
      AGENT_BIN: FAKE_AGENT_BIN,
      SYSTEMCTL_BIN: FAKE_SYSTEMCTL_BIN,
      ...extraEnv,
    },
  });

  const output: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  await waitForPort(port);

  return {
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
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
