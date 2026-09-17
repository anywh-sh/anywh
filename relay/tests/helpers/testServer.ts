import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_AGENT_BIN = resolvePath(HERE, "../fixtures/fake-claude.mjs");
export const FAKE_SYSTEMCTL_BIN = resolvePath(HERE, "../fixtures/fake-systemctl.mjs");

/** Asks the OS for a free ephemeral port by binding to port 0, then releases
 * it immediately — same "probably still free" tradeoff every test suite that
 * needs a real listening server makes. Good enough for local runs and CI. */
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

/** Explicit-synchronization wait (see the skill's "Determinism" section) for
 * the server to actually be accepting connections — `server.ts`'s
 * `httpServer.listen` callback only logs, it isn't awaitable from here. */
function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
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

export interface TestServer {
  port: number;
  /** Root of the fake $HOME this instance runs under (`RELAY_HOME_OVERRIDE`)
   * — real filesystem, real isolation between test runs, no mocking. */
  homeDir: string;
  /** `ANYWH_ENV_DIR` for this instance — real directory on disk, so a test
   * exercising the profile registry (`GET/PATCH/DELETE /control/profiles`)
   * can plant a second profile's `.env` file directly, the same shape
   * `add-profile.sh` would have written, without needing systemd. */
  envDir: string;
  close: () => Promise<void>;
}

/**
 * Boots the real relay (`server.ts`, imported for its side effects — it has
 * no exported bootstrap function, it's a script) against a throwaway `$HOME`
 * and sessions file, with `AGENT_BIN` pointed at the fake `claude` fixture
 * (the one sanctioned mock boundary, see .anywh/skills/tests/SKILL.md).
 * Everything else — HTTP, WebSocket, session persistence to disk, profile
 * registry — is the real module, unmocked.
 *
 * One call per test FILE, not per test case: `server.ts`'s top-level code
 * only runs once per process (ESM module cache), and `node --test` already
 * runs each test file in its own subprocess, so this doesn't leak across
 * files.
 */
export async function startTestServer(): Promise<TestServer> {
  const workDir = mkdtempSync(join(tmpdir(), "anywh-relay-integration-"));
  const homeDir = join(workDir, "home");
  // `homeDir` becomes the cwd of every `claude` child this test's turns
  // spawn (paths.ts defaultCwd) — a nonexistent cwd makes `child_process.spawn`
  // fail with ENOENT on the child itself, not a clearly-labeled "bad cwd"
  // error, which is a real trap this test setup fell into once already.
  mkdirSync(homeDir, { recursive: true });
  const port = await getFreePort();

  process.env.RELAY_PORT = String(port);
  process.env.RELAY_HOST = "127.0.0.1";
  process.env.RELAY_HOME_OVERRIDE = homeDir;
  const envDir = join(workDir, "env");
  process.env.ANYWH_ENV_DIR = envDir;
  process.env.RELAY_SESSIONS_FILE = join(workDir, "sessions.json");
  process.env.RELAY_BACKGROUND_JOBS_FILE = join(workDir, "background-jobs.json");
  process.env.RELAY_WAKEUPS_FILE = join(workDir, "wakeups.json");
  process.env.AGENT_BIN = FAKE_AGENT_BIN;
  // Real incident (2026-09-07): a test hitting `DELETE /control/profiles/:id`
  // with the real `systemctl` disabled+stopped the operator's actual live
  // `anywh-relay@trabalho` service. Never point this at the real binary in
  // a test — see fixtures/fake-systemctl.mjs.
  process.env.SYSTEMCTL_BIN = FAKE_SYSTEMCTL_BIN;

  const serverModule = await import("../../src/server.js");
  await waitForPort(port);

  return {
    port,
    homeDir,
    envDir,
    close: async () => {
      // Tears the live connections down explicitly, instead of asking the
      // servers to close and waiting: a test that fails mid-flight never
      // reaches its own `socket.close()`, and an upgraded WebSocket keeps
      // `httpServer.close()`'s callback from ever firing — so this hook
      // would hang, and with it the whole `node --test` process. Real
      // incident (2026-09-13): one failing assertion in
      // sessionLifecycleExtra.test.ts hung CI's relay job for 30 minutes
      // until it was cancelled by hand, with the reporter never getting to
      // print WHICH assertion failed. A leaked socket has to stay a normal
      // test failure, never a hang.
      for (const client of serverModule.wss.clients) client.terminate();
      await new Promise<void>((resolveClose) => serverModule.wss.close(() => resolveClose()));
      serverModule.httpServer.closeAllConnections();
      await new Promise<void>((resolveClose) => serverModule.httpServer.close(() => resolveClose()));
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
