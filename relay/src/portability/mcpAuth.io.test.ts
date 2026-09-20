import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readMcpAuthStatus, startMcpLogin, type McpLoginSession } from "./mcpAuth.js";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";

// Boundary tier: real homes in a real tmpdir, and a real child process for
// the login — a script standing in for the agent CLI, the same seam the
// integration tests use for `claude` itself. No OAuth server is needed to
// prove what this module owns: that the def's argv reaches the binary,
// that output streams back, that what the user types reaches its stdin,
// and that both drivers behave.

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "anywh-mcp-auth-"));
}

function write(home: string, relativePath: string, contents: string): void {
  const absolute = join(home, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function fakeCli(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "anywh-mcp-login-")), "fake-cli");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The real def with its binary swapped for a script — the argv, the
 * driver and the env still come from the def, which is the part under
 * test. */
function defWithBin(def: AgentRuntimeDef, bin: string): AgentRuntimeDef {
  return { ...def, identity: { ...def.identity, bin } };
}

function collect(login: McpLoginSession): { output: () => string; exit: Promise<number | null> } {
  let output = "";
  login.onData((chunk) => (output += chunk));
  return {
    output: () => output,
    exit: new Promise((resolve) => login.onExit(resolve)),
  };
}

test("readMcpAuthStatus: declared servers, with the one the out-of-band signal names flagged", () => {
  const home = newHome();
  write(home, ".claude.json", JSON.stringify({ mcpServers: { sentry: {}, linear: {} } }));
  write(home, ".claude/mcp-needs-auth-cache.json", JSON.stringify({ linear: { timestamp: 1, id: "x" } }));

  const status = readMcpAuthStatus(claudeRuntimeDef, home);
  assert.equal(status.supported, true);
  assert.equal(status.signal, "file");
  assert.equal(status.loginDriver, "pty");
  assert.deepEqual(status.servers, [
    { name: "sentry", needsAuth: false },
    { name: "linear", needsAuth: true },
  ]);
});

test("readMcpAuthStatus: a server the signal names but the declaration doesn't is still reported", () => {
  // Plugin-provided servers are the real case: the signal file named
  // `plugin:serena:serena` on the machine this was measured on, and no
  // declaration file mentions it.
  const home = newHome();
  write(home, ".claude.json", JSON.stringify({ mcpServers: { sentry: {} } }));
  write(home, ".claude/mcp-needs-auth-cache.json", JSON.stringify({ "plugin:serena:serena": { timestamp: 1, id: "x" } }));

  assert.deepEqual(readMcpAuthStatus(claudeRuntimeDef, home).servers, [
    { name: "sentry", needsAuth: false },
    { name: "plugin:serena:serena", needsAuth: true },
  ]);
});

test("readMcpAuthStatus: an in-band runtime reports its servers with nothing flagged", () => {
  // Not "all fine" — unknowable ahead of time. `signal` is what tells the
  // UI which of the two it's looking at.
  const home = newHome();
  write(home, ".codex/config.toml", '[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n');

  const status = readMcpAuthStatus(codexRuntimeDef, home);
  assert.equal(status.signal, "in-band");
  assert.equal(status.loginDriver, "child");
  assert.deepEqual(status.servers, [{ name: "sentry", needsAuth: false }]);
});

test("readMcpAuthStatus: a home with no declaration and no signal file reports nothing, and doesn't throw", () => {
  const status = readMcpAuthStatus(claudeRuntimeDef, newHome());
  assert.equal(status.supported, true);
  assert.deepEqual(status.servers, []);
});

test("startMcpLogin: the pty driver gets a terminal, and the def's own argv", async () => {
  // Claude refuses without a TTY — the fixture asserts the same thing the
  // real binary does, so a regression that drops the pty fails here.
  const bin = fakeCli('if [ -t 0 ]; then printf "argv=%s\\n" "$*"; else printf "stdin isn\'t a terminal\\n"; exit 1; fi');
  const login = startMcpLogin(defWithBin(claudeRuntimeDef, bin), newHome(), "sentry");
  const { output, exit } = collect(login);

  assert.equal(await exit, 0);
  assert.match(output(), /argv=mcp login --no-browser sentry/);
});

test("startMcpLogin: the CLI's output streams out and what the user types reaches its stdin", async () => {
  // The whole `--no-browser` flow in miniature: the CLI prints a URL, the
  // user pastes the redirect back, the CLI finishes.
  const bin = fakeCli('printf "Open this URL: https://auth.example/authorize?x=1\\n"; read -r pasted; printf "got:%s\\n" "$pasted"');
  const login = startMcpLogin(defWithBin(claudeRuntimeDef, bin), newHome(), "sentry");
  const { output, exit } = collect(login);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(output(), /Open this URL: https:\/\/auth\.example\/authorize/);
  login.write("https://localhost:1234/callback?code=abc\r");

  assert.equal(await exit, 0);
  assert.match(output(), /got:https:\/\/localhost:1234\/callback\?code=abc/);
});

test("startMcpLogin: the child driver needs no terminal, and merges stderr in", async () => {
  // Codex's measured shape: no TTY required, and its prompts arrive on
  // stderr — collected only because this driver merges both streams.
  const bin = fakeCli('printf "argv=%s\\n" "$*" >&2; if [ -t 0 ]; then printf "unexpected tty\\n" >&2; exit 1; fi');
  const login = startMcpLogin(defWithBin(codexRuntimeDef, bin), newHome(), "sentry");
  const { output, exit } = collect(login);

  assert.equal(await exit, 0);
  assert.match(output(), /argv=mcp login sentry/);
});

test("startMcpLogin: runs under the config home it was given, not the relay's own", async () => {
  const home = newHome();
  const bin = fakeCli('printf "HOME=%s\\n" "$HOME"');
  const { output, exit } = collect(startMcpLogin(defWithBin(claudeRuntimeDef, bin), home, "sentry"));

  assert.equal(await exit, 0);
  assert.match(output(), new RegExp(`HOME=${home}`));
});

test("startMcpLogin: the billed credential never reaches the login either", async () => {
  const bin = fakeCli('printf "key=%s\\n" "${ANTHROPIC_API_KEY:-absent}"');
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  try {
    const { output, exit } = collect(startMcpLogin(defWithBin(claudeRuntimeDef, bin), newHome(), "sentry"));
    assert.equal(await exit, 0);
    assert.match(output(), /key=absent/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("startMcpLogin: kill ends a flow the user walked away from", async () => {
  // The fixture blocks on `read` forever, exactly like a real login
  // waiting for a redirect URL that is never coming. Closing the socket
  // has to end it: an abandoned OAuth flow left running holds a callback
  // listener nobody will reach.
  const bin = fakeCli("read -r ignored");
  const login = startMcpLogin(defWithBin(claudeRuntimeDef, bin), newHome(), "sentry");
  const { exit } = collect(login);
  login.kill();
  const settled = await Promise.race([exit.then(() => "exited"), new Promise((resolve) => setTimeout(() => resolve("still running"), 2000))]);
  assert.equal(settled, "exited");
});

test("startMcpLogin: refuses a runtime that declares no MCP support, instead of spawning something", () => {
  const noMcp: AgentRuntimeDef = { ...claudeRuntimeDef, portability: { ...claudeRuntimeDef.portability, mcp: { kind: "none" } } };
  assert.throws(() => startMcpLogin(noMcp, newHome(), "sentry"), /declares no MCP support/);
});
