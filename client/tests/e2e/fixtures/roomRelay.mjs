// A real relay, a real agent host and the fake `claude` (the relay's own
// sanctioned test boundary), started as separate processes for the specs that
// need a room to exist. Everything the app talks to is real except the
// agent: its behaviour is scripted by markers in the messages it is sent (the
// host drives it in the persistent mode of relay/tests/fixtures/fake-claude.mjs,
// whose markers are listed in fake-claude-persistent.mjs).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RELAY_ROOT = resolve(import.meta.dirname, "../../../../relay");
const FAKE_AGENT = resolve(RELAY_ROOT, "tests/fixtures/fake-claude.mjs");
const FAKE_SYSTEMCTL = resolve(RELAY_ROOT, "tests/fixtures/fake-systemctl.mjs");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const attempt = () => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolveWait();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`relay did not listen on ${String(port)}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

/** Starts the stack. `stop()` ends exactly the processes started here. */
export async function startRoomRelay() {
  const started = [];
  try {
    return await start(started);
  } catch (error) {
    // A stack that never came up must not leave its processes behind: they
    // would keep the test run from ever exiting.
    await stopAll(started);
    throw error;
  }
}

async function stopAll(started) {
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.all(
    started.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
          const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolveExit();
          });
        }),
    ),
  );
}

async function start(children) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-e2e-room-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const output = [];
  const run = (args, env) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: RELAY_ROOT, env: { ...process.env, ...env } });
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    children.push(child);
    return child;
  };

  const socketPath = join(dir, "run", "host.sock");
  run(
    ["src/agentHost/main.ts", "--profile", "e2e", "--host-id", `e2e-${String(process.pid)}`, "--socket", socketPath, "--data-dir", join(dir, "data")],
    { ANYWH_AGENT_HOST_DRAIN_GRACE_MS: "500", ANYWH_AGENT_HOST_HIBERNATE: "off", RELAY_HOME_OVERRIDE: home, AGENT_BIN: FAKE_AGENT },
  );
  const port = await freePort();
  run(["src/server.ts"], {
    RELAY_PORT: String(port),
    RELAY_HOST: "127.0.0.1",
    RELAY_HOME_OVERRIDE: home,
    ANYWH_ENV_DIR: join(dir, "env"),
    RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
    RELAY_BACKGROUND_JOBS_FILE: join(dir, "background-jobs.json"),
    AGENT_BIN: FAKE_AGENT,
    SYSTEMCTL_BIN: FAKE_SYSTEMCTL,
    ANYWH_AGENT_HOST_SOCKET: socketPath,
    ANYWH_SESSIONS_ROOT: join(dir, "sessions-root"),
    // A room's digest and warm-up timers would only make a screenshot of
    // the canvas depend on the clock.
    RELAY_ROOM_DIGEST_WINDOW_MS: "600000",
    RELAY_ROOM_WARMUP_MS: "0",
  });
  try {
    await waitForPort(port);
  } catch (error) {
    throw new Error(`${error.message}\n${output.join("").slice(-3000)}`);
  }

  const base = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;
  // The agent host connects after the relay is up: a room needs it.
  while ((await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200) {
    if (Date.now() > deadline) throw new Error(`the agent host never connected\n${output.join("").slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    port,
    base,
    dir,
    output,
    async stop() {
      await stopAll(children);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The marker the fake agent reads as "call this tool of the room's server". */
export function roomMarker(tool, args) {
  return `[[room:${tool}:${Buffer.from(JSON.stringify(args)).toString("base64url")}]]`;
}

/** The marker for a tool call that needs the person's approval. */
export function askMarker(call) {
  return `[[ask:${Buffer.from(JSON.stringify(call)).toString("base64url")}]]`;
}
