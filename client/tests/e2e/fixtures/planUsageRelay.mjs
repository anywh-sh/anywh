// A real relay per profile for usage.spec.js: the compiled relay with the
// fake `claude` (the relay's sanctioned test boundary), which answers
// `auth status` and the usage probe with a `rate_limit_event` read from a
// file, and a `codex` stand-in on the PATH that only answers `--version` —
// installed, never logged in. No agent host: nothing here runs a turn.
//
// The relays of one machine share their profile registry (`ANYWH_ENV_DIR`
// and the `profiles.json` beside it), as `add-profile.sh` sets them up: the
// app syncs its profile list per host from `GET /control/profiles`, and a
// relay that only knew itself would make the app drop the other profile on
// the same host.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const RELAY_ROOT = resolve(import.meta.dirname, "../../../../relay");
const SERVER = resolve(RELAY_ROOT, "dist/server.js");
const FAKE_AGENT = resolve(RELAY_ROOT, "tests/fixtures/fake-claude.mjs");
const FAKE_SYSTEMCTL = resolve(RELAY_ROOT, "tests/fixtures/fake-systemctl.mjs");

/** Same port picking as roomRelay.mjs: outside the ephemeral range. */
async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const free = await new Promise((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port found in 20000-29999");
}

function waitForListen(port, child, output, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, reject) => {
    const attempt = () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error(`relay exited (code ${String(child.exitCode)})\n${output.join("").slice(-3000)}`));
      if (output.join("").includes(`[relay] listening on ws://127.0.0.1:${String(port)}`)) {
        const socket = connect({ port, host: "127.0.0.1" }, () => {
          socket.end();
          done();
        });
        socket.on("error", () => setTimeout(attempt, 50));
      } else if (Date.now() > deadline) reject(new Error(`relay did not listen on ${String(port)}\n${output.join("").slice(-3000)}`));
      else setTimeout(attempt, 50);
    };
    attempt();
  });
}

/**
 * Starts one relay per entry of `profiles` (`{ id, label, fiveHour,
 * sevenDay }`, the fractions its Claude account sits at once probed), on one
 * shared registry. Each gets its own home, so its own account key. Returns
 * the relays by id plus `stop()`, which ends exactly these processes.
 */
export async function startPlanUsageMachine(profiles) {
  if (!existsSync(SERVER)) throw new Error("the relay is not built: run `npm run build` in relay/ first");
  const root = mkdtempSync(join(tmpdir(), "anywh-e2e-usage-"));
  const envDir = join(root, "config", "env");
  mkdirSync(envDir, { recursive: true });
  const ports = [];
  for (const _ of profiles) {
    let port;
    do port = await freePort();
    while (ports.includes(port));
    ports.push(port);
  }
  writeFileSync(
    join(root, "config", "profiles.json"),
    JSON.stringify({ version: 1, profiles: profiles.map(({ id, label }, index) => ({ id, label, colorIndex: index })) }),
  );
  profiles.forEach(({ id }, index) => {
    writeFileSync(join(envDir, `${id}.env`), `RELAY_PORT=${String(ports[index])}\nRELAY_HOST=127.0.0.1\nRELAY_HOME_OVERRIDE=${join(root, id, "home")}\n`);
  });
  const relays = {};
  try {
    for (const [index, profile] of profiles.entries()) {
      relays[profile.id] = await startRelay(join(root, profile.id), envDir, ports[index], profile);
    }
  } catch (error) {
    await Promise.all(Object.values(relays).map((relay) => relay.stop()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    relays,
    async stop() {
      await Promise.all(Object.values(relays).map((relay) => relay.stop()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startRelay(dir, envDir, port, { id, fiveHour, sevenDay }) {
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  // The account ids the relay hashes into the account key; never sent.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `acc-${id}`, organizationUuid: `org-${id}` } }));
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; exit 0; fi\nexit 1\n');
  chmodSync(join(bin, "codex"), 0o755);
  const rateLimitFile = join(dir, "rate-limit.json");
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    rateLimitFile,
    JSON.stringify({
      status: "allowed",
      resetsAt: now + 72 * 60,
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: now + 72 * 60 }, seven_day: { utilization: sevenDay, resetsAt: now + 2 * 86400 + 5 * 3600 } },
    }),
  );
  const invocations = join(dir, "claude-invocations.jsonl");
  // A real `codex` on this machine must not be the one detected.
  const path = [bin, ...(process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !existsSync(join(entry, "codex")))].join(delimiter);

  const output = [];
  const child = spawn(process.execPath, [SERVER], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      PATH: path,
      EXTRA_PATH_DIRS: "",
      RELAY_PORT: String(port),
      RELAY_HOST: "127.0.0.1",
      RELAY_HOME_OVERRIDE: home,
      HOME: home,
      ANYWH_ENV_DIR: envDir,
      RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
      RELAY_BACKGROUND_JOBS_FILE: join(dir, "background-jobs.json"),
      AGENT_BIN: FAKE_AGENT,
      SYSTEMCTL_BIN: FAKE_SYSTEMCTL,
      ANYWH_AGENT_HOST_SOCKET: join(dir, "no-agent-host.sock"),
      ANYWH_SESSIONS_ROOT: join(dir, "sessions-root"),
      FAKE_CLAUDE_RATE_LIMIT_FILE: rateLimitFile,
      FAKE_CLAUDE_INVOCATIONS_FILE: invocations,
    },
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((done) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  };
  try {
    await waitForListen(port, child, output);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    port,
    output,
    /** The usage probes the relay ran (`claude -p ok … --max-turns`). */
    probes() {
      if (!existsSync(invocations)) return [];
      return readFileSync(invocations, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).args)
        .filter((args) => args[0] === "-p" && args.includes("--max-turns"));
    },
    stop,
  };
}
