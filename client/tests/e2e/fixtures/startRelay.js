import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join, resolve } from "node:path";

// A real relay from this checkout's relay/dist, for the e2e specs that need
// one running before the app looks (an existing install to adopt) — the
// same environment fake-install.sh gives the one it starts: the fake
// `claude` as its agent, a fake `systemctl`, every file under `stateDir`.

const relayDir = resolve(import.meta.dirname, "../../../../relay");

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function answers(port) {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Starts the relay and resolves once it listens. A port taken between
 * picking it and the relay binding it is retried on another. `envDir` is
 * the profile directory it reads (its own under `stateDir` by default);
 * `beforeStart(port)` runs once the port is known and before the relay
 * starts — where a spec writes the profile that relay is. Stop it with
 * `process.kill(pid)` — that exact process, never a pattern. */
export async function startRelay(stateDir, { envDir = join(stateDir, "env"), beforeStart = () => {} } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    beforeStart(port);
    mkdirSync(join(stateDir, "home"), { recursive: true });
    const child = spawn(process.execPath, [join(relayDir, "dist/server.js")], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        RELAY_PORT: String(port),
        RELAY_HOST: "127.0.0.1",
        RELAY_HOME_OVERRIDE: join(stateDir, "home"),
        ANYWH_ENV_DIR: envDir,
        RELAY_SESSIONS_FILE: join(stateDir, "sessions.json"),
        RELAY_BACKGROUND_JOBS_FILE: join(stateDir, "background-jobs.json"),
        RELAY_WAKEUPS_FILE: join(stateDir, "wakeups.json"),
        RELAY_PUSH_DEVICES_FILE: join(stateDir, "push-devices.json"),
        AGENT_BIN: join(relayDir, "tests/fixtures/fake-claude.mjs"),
        SYSTEMCTL_BIN: join(relayDir, "tests/fixtures/fake-systemctl.mjs"),
        ANYWH_AGENT_HOST_SOCKET: join(stateDir, "agent-host.sock"),
        ANYWH_SESSIONS_ROOT: join(stateDir, "sessions-root"),
      },
    });
    child.unref();
    let exited = false;
    child.once("exit", () => (exited = true));
    for (let i = 0; i < 100 && !exited; i++) {
      if (await answers(port)) return { port, pid: child.pid };
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!exited) process.kill(child.pid, "SIGTERM");
  }
  throw new Error("startRelay: the relay never came up");
}
