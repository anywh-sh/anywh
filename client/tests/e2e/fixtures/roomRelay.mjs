// A real relay, a real agent host and the fake `claude` (the relay's own
// sanctioned test boundary), started as separate processes for the specs that
// need a room to exist. Everything the app talks to is real except the
// agent: its behaviour is scripted by markers in the messages it is sent (the
// host drives it in the persistent mode of relay/tests/fixtures/fake-claude.mjs,
// whose markers are listed in fake-claude-persistent.mjs).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RELAY_ROOT = resolve(import.meta.dirname, "../../../../relay");
// The compiled relay, as it runs in production. Not `tsx`: on the CI runner
// the TypeScript loader died at startup inside esbuild (`Expected id 1 but
// got id 0`) next to a running Tauri app, and nothing here needs it.
const SERVER = resolve(RELAY_ROOT, "dist/server.js");
const HOST = resolve(RELAY_ROOT, "dist/agentHost/main.js");
const FAKE_AGENT = resolve(RELAY_ROOT, "tests/fixtures/fake-claude.mjs");
const FAKE_SYSTEMCTL = resolve(RELAY_ROOT, "tests/fixtures/fake-systemctl.mjs");

/** A port nothing listens on, picked outside the OS's ephemeral range: one
 * taken from the OS is released before the relay binds it, and in that window
 * another process's outbound connection (the Tauri app next to it, a second
 * relay) can be handed the same number. */
async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const free = await new Promise((resolveFree) => {
      const probe = createServer();
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port found in 20000-29999");
}

/** Resolves when the relay itself says it listens on `port` (a connection to
 * the port would also succeed against some other process that holds it);
 * rejects at once if a child process exits first (waiting out a deadline for
 * a process that is gone only hides why). */
function waitForPort(port, children, output, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const attempt = () => {
      const gone = children.find((child) => child.exitCode !== null || child.signalCode !== null);
      if (gone) return reject(new Error(`a relay process exited before listening on ${String(port)} (code ${String(gone.exitCode)})`));
      if (output.join("").includes(`[relay] listening on ws://127.0.0.1:${String(port)}`)) {
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          socket.end();
          resolveWait();
        });
        socket.on("error", () => {
          socket.destroy();
          setTimeout(attempt, 50);
        });
      } else if (Date.now() > deadline) reject(new Error(`relay did not listen on ${String(port)}`));
      else setTimeout(attempt, 50);
    };
    attempt();
  });
}

/** Starts the stack. `stop()` ends exactly the processes started here. */
export async function startRoomRelay() {
  // The port is free when picked, not when the relay binds it: one that lost
  // it to another process exits on EADDRINUSE, and gets a new one.
  for (let attempt = 1; ; attempt++) {
    const started = [];
    try {
      return await start(started);
    } catch (error) {
      // A stack that never came up must not leave its processes behind: they
      // would keep the test run from ever exiting.
      await stopAll(started);
      if (attempt >= 3 || !String(error.message).includes("EADDRINUSE")) throw error;
    }
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
  if (!existsSync(SERVER) || !existsSync(HOST)) throw new Error("the relay is not built: run `npm run build` in relay/ first");
  const dir = mkdtempSync(join(tmpdir(), "anywh-e2e-room-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const output = [];
  const run = (args, env) => {
    const child = spawn(process.execPath, args, { cwd: RELAY_ROOT, env: { ...process.env, NODE_OPTIONS: "", ...env } });
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    children.push(child);
    return child;
  };

  const socketPath = join(dir, "run", "host.sock");
  run(
    [HOST, "--profile", "e2e", "--host-id", `e2e-${String(process.pid)}`, "--socket", socketPath, "--data-dir", join(dir, "data")],
    { ANYWH_AGENT_HOST_DRAIN_GRACE_MS: "500", ANYWH_AGENT_HOST_HIBERNATE: "off", RELAY_HOME_OVERRIDE: home, AGENT_BIN: FAKE_AGENT },
  );
  const port = await freePort();
  run([SERVER], {
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
    await waitForPort(port, children, output);
  } catch (error) {
    throw new Error(`${error.message}\n${output.join("").slice(-3000)}`);
  }

  const base = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;
  // The agent host connects after the relay is up: a room needs it.
  while ((await fetch(`${base}/agents/activity`).catch(() => ({ status: 0 }))).status !== 200) {
    const gone = children.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (gone || Date.now() > deadline) throw new Error(`the agent host never connected\n${output.join("").slice(-2000)}`);
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
