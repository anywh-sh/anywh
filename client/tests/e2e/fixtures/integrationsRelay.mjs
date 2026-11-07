// A real relay whose profile has Jira, for integrations.spec.js: the
// compiled relay with the fake `claude` (the relay's sanctioned test
// boundary), which lists the recorded MCP inventory — `claude.ai Atlassian`
// connected — and answers Atlassian's tools from
// relay/tests/fixtures/fake-atlassian.mjs, and a `codex` on the PATH that runs
// the fake `codex app-server`, whose official Atlassian server is declared
// but not signed in (so the profile has one agent to connect). No agent host,
// no Atlassian, no OAuth server: the fakes answer with their recorded shapes.
//
// Everything a real CLI could be found through is cut off: `HOME` is a
// throwaway folder (the relay looks for agent CLIs under `~/.local/bin` too,
// where a developer's real `codex` lives), the fake `codex` comes first on
// PATH, shadowing any real one, and `EXTRA_PATH_DIRS` is emptied.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELAY_ROOT = resolve(import.meta.dirname, "../../../../relay");
const SERVER = resolve(RELAY_ROOT, "dist/server.js");
const FAKE_AGENT = resolve(RELAY_ROOT, "tests/fixtures/fake-claude.mjs");
const FAKE_CODEX = resolve(RELAY_ROOT, "tests/fixtures/fake-codex-app-server.mjs");
const FAKE_SYSTEMCTL = resolve(RELAY_ROOT, "tests/fixtures/fake-systemctl.mjs");
// The recorded inventory replies, as the relay's own tests feed the fakes.
const FIXTURES = resolve(RELAY_ROOT, "dist/integrations/inventory/fixtures.js");
// Node 20 has no global WebSocket: the relay's own client library.
const WebSocket = createRequire(join(RELAY_ROOT, "package.json"))("ws");

/** The Atlassian site the fakes answer for (fake-atlassian.mjs). */
export const FAKE_JIRA_SITE = { id: "00000000-0000-4000-8000-0000000000a1", url: "https://example-team.atlassian.net", host: "example-team.atlassian.net" };

/**
 * Writes the fakes' files under `dir` and returns the env that makes a relay
 * (and an agent host) see a profile with Jira: `claude.ai Atlassian`
 * connected in Claude, the official server not signed in in Codex. Shared
 * with roomRelay.mjs.
 */
export async function jiraFakeEnv(dir) {
  const { CLAUDE_MCP_STATUS_SETTLED, CODEX_MCP_LIST_STDOUT, CODEX_MCP_STATUS_LIST } = await import(pathToFileURL(FIXTURES).href);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // First on PATH: this node (the fake claude runs through
  // `#!/usr/bin/env node`) and the fake `codex`, which shadows a real one.
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const files = {
    claudeStatus: join(dir, "claude-mcp-status.json"),
    codexList: join(dir, "codex-mcp-list.json"),
    codexStatus: join(dir, "codex-mcp-status.json"),
    atlassianCalls: join(dir, "atlassian-calls.jsonl"),
    claudeControl: join(dir, "claude-control.jsonl"),
  };
  writeFileSync(files.claudeStatus, JSON.stringify(CLAUDE_MCP_STATUS_SETTLED));
  // Only the official server in Codex: the community one would be picked
  // there (connected), and the profile would have nothing to connect.
  writeFileSync(files.codexList, JSON.stringify(JSON.parse(CODEX_MCP_LIST_STDOUT).filter((server) => server.name !== "jira-local")));
  writeFileSync(files.codexStatus, JSON.stringify({ ...CODEX_MCP_STATUS_LIST, data: CODEX_MCP_STATUS_LIST.data.filter((server) => server.name !== "jira-local") }));
  return {
    files,
    env: {
      HOME: home,
      RELAY_HOME_OVERRIDE: home,
      PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      EXTRA_PATH_DIRS: "",
      FAKE_CLAUDE_MCP_STATUS_FILE: files.claudeStatus,
      FAKE_CODEX_MCP_LIST_FILE: files.codexList,
      FAKE_CODEX_MCP_STATUS_FILE: files.codexStatus,
      FAKE_ATLASSIAN_CALLS_FILE: files.atlassianCalls,
      FAKE_CLAUDE_CONTROL_FILE: files.claudeControl,
    },
  };
}

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
        socket.on("error", () => {
          socket.destroy();
          setTimeout(attempt, 50);
        });
      } else if (Date.now() > deadline) reject(new Error(`relay did not listen on ${String(port)}\n${output.join("").slice(-3000)}`));
      else setTimeout(attempt, 50);
    };
    attempt();
  });
}

const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/**
 * Starts the relay of profile `id` (`label`) on its own registry, as
 * `add-profile.sh` sets one up. `pageSize` caps the fake's search pages.
 * Returns its port, a way to start a session on a work ticket, what the
 * fakes were asked, and `stop()`, which ends exactly this process.
 */
export async function startIntegrationsRelay({ id, label, pageSize = 50 }) {
  if (!existsSync(SERVER)) throw new Error("the relay is not built: run `npm run build` in relay/ first");
  const dir = mkdtempSync(join(tmpdir(), "anywh-e2e-integrations-"));
  const envDir = join(dir, "config", "env");
  mkdirSync(envDir, { recursive: true });
  const { env: jira, files } = await jiraFakeEnv(dir);
  const port = await freePort();
  writeFileSync(join(dir, "config", "profiles.json"), JSON.stringify({ version: 1, profiles: [{ id, label, colorIndex: 0 }] }));
  writeFileSync(join(envDir, `${id}.env`), `RELAY_PORT=${String(port)}\nRELAY_HOST=127.0.0.1\nRELAY_HOME_OVERRIDE=${jira.HOME}\n`);

  const output = [];
  const child = spawn(process.execPath, [SERVER], {
    cwd: RELAY_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      ...jira,
      RELAY_PORT: String(port),
      RELAY_HOST: "127.0.0.1",
      ANYWH_ENV_DIR: envDir,
      RELAY_SESSIONS_FILE: join(dir, "sessions.json"),
      RELAY_BACKGROUND_JOBS_FILE: join(dir, "background-jobs.json"),
      RELAY_WAKEUPS_FILE: join(dir, "wakeups.json"),
      RELAY_PUSH_DEVICES_FILE: join(dir, "push-devices.json"),
      AGENT_BIN: FAKE_AGENT,
      SYSTEMCTL_BIN: FAKE_SYSTEMCTL,
      ANYWH_AGENT_HOST_SOCKET: join(dir, "no-agent-host.sock"),
      ANYWH_SESSIONS_ROOT: join(dir, "sessions-root"),
      FAKE_ATLASSIAN_PAGE_SIZE: String(pageSize),
    },
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((done) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await waitForListen(port, child, output);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    port,
    base: `http://127.0.0.1:${String(port)}`,
    dir,
    output,
    /** The Atlassian tools the fakes were called with (`{via, tool, arguments}`). */
    atlassianCalls: () => readLines(files.atlassianCalls),
    /**
     * Starts session `sessionId` with one message that carries `key` as its
     * work ticket — what the app's first message on the new-session screen
     * sends — and resolves once that turn ended and the relay linked it. The
     * session is then named `title` (the fake's generated title is a bare
     * "ok"), once the generated one is in, so it cannot overwrite the name.
     */
    async startSessionOnTicket(sessionId, key, text, title) {
      await startSessionOnTicket(port, sessionId, key, text);
      const base = `http://127.0.0.1:${String(port)}`;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { sessions } = await (await fetch(`${base}/sessions`)).json();
        const session = sessions.find((entry) => entry.id === sessionId);
        if (session?.title && !session.titlePending) break;
        if (Date.now() > deadline) throw new Error(`session ${sessionId} never got its generated title`);
        await new Promise((done) => setTimeout(done, 100));
      }
      const renamed = await fetch(`${base}/sessions/rename`, { method: "POST", body: JSON.stringify({ id: sessionId, title }) });
      if (!renamed.ok) throw new Error(`could not name session ${sessionId}: ${String(renamed.status)}`);
    },
    stop,
  };
}

function startSessionOnTicket(port, sessionId, key, text) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/?session=${sessionId}`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`session ${sessionId} never finished its first turn`));
    }, 30_000);
    let sent = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "caught_up" && !sent) {
        sent = true;
        socket.send(JSON.stringify({ type: "user_message", text, startTicket: { provider: "jira", site: FAKE_JIRA_SITE.id, key } }));
      } else if (message.type === "agent_event" && message.event?.type === "turn_ended") {
        clearTimeout(timer);
        socket.close();
        done();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
