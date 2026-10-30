// `GET /control/agents` against a real relay process: the fake `claude`
// (logged in, then out) and a `codex` that is first missing from the
// relay's PATH and then installed while the relay runs — the "check again"
// case the endpoint exists for, which must also reach `/host-info` without
// a restart. `codex` is a small wrapper standing in for the CLI (one of the
// sanctioned mock boundaries): it answers `--version` and `login status`
// itself and hands anything else to the fake app-server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnRelay, type SpawnedServer } from "./helpers/spawnedServer.js";

const FAKE_CODEX_APP_SERVER = resolve(import.meta.dirname, "fixtures/fake-codex-app-server.mjs");

interface AgentEntry {
  id: string;
  bin: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
  loginCommand: string | null;
  installUrl: string | null;
  docsUrl: string | null;
}

let relay: SpawnedServer | undefined;
let dir: string;
let binDir: string;
let base: string;
let claudeLoggedOutFile: string;
let codexLoggedInFile: string;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The relay finds `codex` on its PATH or in a few well-known directories
// (runtimes/executables.ts). The per-user ones follow $HOME, which this test
// points at a throwaway directory; a machine-wide install can't be hidden.
const SYSTEM_CODEX = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find(isExecutable);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "anywh-control-agents-"));
  const home = join(dir, "home");
  mkdirSync(home);
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  claudeLoggedOutFile = join(dir, "claude-logged-out");
  codexLoggedInFile = join(dir, "codex-logged-in");
  // A real `codex` anywhere on the inherited PATH would answer for the
  // missing one, so every directory holding one is dropped. That can drop
  // `node` along with it (nvm installs both in one directory), and the fake
  // claude runs through `#!/usr/bin/env node`: this test's own node goes
  // first on the PATH instead.
  symlinkSync(process.execPath, join(binDir, "node"));
  const inheritedPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && !isExecutable(join(entry, "codex")));
  relay = await spawnRelay({
    HOME: home,
    PATH: [binDir, ...inheritedPath].join(delimiter),
    // Inherited from a shell, it can put a real `codex` ahead of the fake.
    EXTRA_PATH_DIRS: "",
    FAKE_CLAUDE_LOGGED_OUT_FILE: claudeLoggedOutFile,
  });
  base = `http://127.0.0.1:${relay.port}`;
});

after(() => {
  relay?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function installCodex(): void {
  // Shapes from codex-cli 0.154.0: `--version` on stdout, `login status`
  // answering on stderr with the verdict in the exit code.
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; exit 0; fi',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
    `  if [ -e "${codexLoggedInFile}" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi`,
    '  echo "Not logged in" >&2; exit 1',
    "fi",
    `exec "${process.execPath}" "${FAKE_CODEX_APP_SERVER}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(binDir, "codex"), script);
  chmodSync(join(binDir, "codex"), 0o755);
}

async function controlAgents(): Promise<{ status: number; cors: string | null; agents: AgentEntry[] }> {
  const res = await fetch(`${base}/control/agents`);
  const body = (await res.json()) as { agents: AgentEntry[] };
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), agents: body.agents };
}

async function hostInfoAgents(): Promise<string[]> {
  const info = (await (await fetch(`${base}/host-info`)).json()) as { agents?: { id: string }[] };
  return (info.agents ?? []).map((agent) => agent.id);
}

function byId(agents: AgentEntry[], id: string): AgentEntry {
  const entry = agents.find((agent) => agent.id === id);
  assert.ok(entry, `no ${id} entry in ${JSON.stringify(agents)}`);
  return entry;
}

test("lists every known agent, the missing ones too, with what the onboarding needs to show them", { skip: SYSTEM_CODEX && `a machine-wide codex at ${SYSTEM_CODEX} can't be hidden` }, async () => {
  const { status, cors, agents } = await controlAgents();
  assert.equal(status, 200);
  assert.equal(cors, "*");
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["claude", "codex"],
  );

  assert.deepEqual(byId(agents, "claude"), {
    id: "claude",
    bin: "fake-claude.mjs",
    installed: true,
    version: "2.1.0",
    loggedIn: true,
    loginCommand: "fake-claude.mjs auth login",
    installUrl: "https://code.claude.com/docs/en/setup",
    docsUrl: null,
  });
  assert.deepEqual(byId(agents, "codex"), {
    id: "codex",
    bin: "codex",
    installed: false,
    version: null,
    loggedIn: null,
    loginCommand: "codex login",
    installUrl: "https://developers.openai.com/codex/cli",
    docsUrl: "https://github.com/openai/codex",
  });
});

test("a logged-out agent is still listed as installed, with loggedIn false", async () => {
  writeFileSync(claudeLoggedOutFile, "");
  try {
    const claude = byId((await controlAgents()).agents, "claude");
    assert.equal(claude.installed, true);
    assert.equal(claude.loggedIn, false);
  } finally {
    rmSync(claudeLoggedOutFile, { force: true });
  }
  assert.equal(byId((await controlAgents()).agents, "claude").loggedIn, true, "detected afresh on every call, never cached");
});

test("an agent installed while the relay runs shows up on the next call, and in /host-info without a restart", { skip: SYSTEM_CODEX && `a machine-wide codex at ${SYSTEM_CODEX} can't be hidden` }, async () => {
  assert.deepEqual(await hostInfoAgents(), ["claude"]);

  installCodex();
  const codex = byId((await controlAgents()).agents, "codex");
  assert.equal(codex.installed, true);
  assert.equal(codex.version, "0.154.0");
  assert.equal(codex.loggedIn, false, "`codex login status` exited 1");
  assert.deepEqual(await hostInfoAgents(), ["claude", "codex"]);

  writeFileSync(codexLoggedInFile, "");
  assert.equal(byId((await controlAgents()).agents, "codex").loggedIn, true);
});
