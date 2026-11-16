import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeRuntimeDef } from "../defs/claude/index.js";
import { codexRuntimeDef } from "../defs/codex.js";
import { kimiRuntimeDef } from "../defs/kimi.js";
import type { AgentRuntimeDef } from "../types.js";
import { splitTrailingEscape, startAgentLogin, stripTerminalCodes, type AgentLoginEvent, type AgentLoginSession } from "./agentLogin.js";

// The fakes stand in for each CLI at its own sanctioned boundary (the
// `claude` process, an ACP agent's CLI, `codex app-server`): they prove the
// engine's wiring against each CLI's measured shapes, not the CLI itself.
const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures");

function withFake(def: AgentRuntimeDef, script: string, env: Record<string, string> = {}): AgentRuntimeDef {
  return { ...def, identity: { ...def.identity, bin: join(FIXTURES, script), binDirs: [], env: { ...def.identity.env, set: { ...def.identity.env.set, ...env } } } };
}

function scratchHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "anywh-agent-login-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Collects events until `until` matches one, or fails after `ms`. */
function collect(login: AgentLoginSession, until: (event: AgentLoginEvent) => boolean, ms = 5000): Promise<AgentLoginEvent[]> {
  return new Promise((resolveEvents, reject) => {
    const events: AgentLoginEvent[] = [];
    const timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(events.map((e) => e.type))}`)), ms);
    login.onEvent((event) => {
      events.push(event);
      if (until(event)) {
        clearTimeout(timer);
        resolveEvents(events);
      }
    });
  });
}

const isEnd = (event: AgentLoginEvent): boolean => event.type === "succeeded" || event.type === "failed" || event.type === "rejected";

function waitForFile(path: string, ms = 5000): Promise<string> {
  const started = Date.now();
  return new Promise((resolveText, reject) => {
    const poll = (): void => {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (text.length > 0) return resolveText(text);
      }
      if (Date.now() - started > ms) return reject(new Error(`${path} never appeared`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, ms = 5000): Promise<void> {
  const started = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - started > ms) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("stripTerminalCodes drops colour, hyperlinks and spinner returns", () => {
  assert.equal(stripTerminalCodes("\x1b[1mvisit:\x1b[0m \x1b]8;;https://a.test\x07https://a.test\x1b]8;;\x07\r\n"), "visit: https://a.test\n");
});

test("cli-paste: the prompt asks for a code, runs under the profile's HOME with no browser, and a good code signs in", async (t) => {
  const home = scratchHome(t);
  const envFile = join(home, "login-env.json");
  const login = startAgentLogin(withFake(claudeRuntimeDef, "fake-claude.mjs", { FAKE_CLAUDE_LOGIN_ENV_FILE: envFile }), { homeOverride: home });
  t.after(() => login.cancel());

  const prompted = await collect(login, (event) => event.type === "prompt");
  const prompt = prompted.at(-1);
  assert.deepEqual(prompt, { type: "prompt", prompt: { url: "https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=fake" }, input: "code" });
  const env = JSON.parse(await waitForFile(envFile)) as NodeJS.ProcessEnv;
  assert.equal(env.HOME, home);
  assert.equal(env.BROWSER, "true");

  const ending = collect(login, isEnd);
  login.submitCode("  good-code  ");
  assert.equal((await ending).at(-1)?.type, "succeeded");
});

test("cli-paste: a refused code is a rejection carrying the CLI's own words, and a second code is ignored", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(claudeRuntimeDef, "fake-claude.mjs"), { homeOverride: home });
  t.after(() => login.cancel());
  await collect(login, (event) => event.type === "prompt");
  const ending = collect(login, isEnd);
  login.submitCode("wrong#code");
  login.submitCode("good-code");
  const last = (await ending).at(-1);
  assert.equal(last?.type, "rejected");
  assert.match((last as { detail?: string }).detail ?? "", /wasn't accepted/);
});

test("cli-paste: a code the CLI finds malformed keeps the login going, and the next code can still sign in", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(claudeRuntimeDef, "fake-claude.mjs"), { homeOverride: home });
  t.after(() => login.cancel());
  await collect(login, (event) => event.type === "prompt");
  const invalid = collect(login, (event) => event.type === "invalid-code" || isEnd(event));
  login.submitCode("asdsda");
  assert.deepEqual((await invalid).at(-1), { type: "invalid-code", detail: "Invalid code. Please make sure the full code was copied." });
  const ending = collect(login, isEnd);
  login.submitCode("good-code");
  assert.equal((await ending).at(-1)?.type, "succeeded");
});

test("cli-paste: output no parser recognizes still reaches the caller, with no prompt", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(claudeRuntimeDef, "fake-claude.mjs", { FAKE_CLAUDE_LOGIN_GARBLED: "1" }), { homeOverride: home });
  t.after(() => login.cancel());
  const events = await collect(login, (event) => event.type === "output");
  assert.deepEqual(events, [{ type: "output", data: "Something this version prints that nobody parses.\n" }]);
});

test("cli-device: the prompt carries the code and expiry, wants no input, and approval signs in", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(kimiRuntimeDef, "fake-acp-agent.mjs"), { homeOverride: home });
  t.after(() => login.cancel());
  const events = await collect(login, isEnd);
  assert.deepEqual(
    events.find((event) => event.type === "prompt"),
    {
      type: "prompt",
      prompt: { url: "https://www.kimi.ai/code/authorize_device?user_code=FAKE-CODE", userCode: "FAKE-CODE", expiresInSec: 1800 },
      input: "none",
    },
  );
  assert.equal(events.at(-1)?.type, "succeeded");
});

test("cli-device: a denial is a failure with the CLI's reason", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(kimiRuntimeDef, "fake-acp-agent.mjs", { FAKE_ACP_LOGIN: "deny" }), { homeOverride: home });
  t.after(() => login.cancel());
  const last = (await collect(login, isEnd)).at(-1);
  assert.deepEqual(last, { type: "failed", detail: "Error: authorization was denied" });
});

test("cancel kills the CLI and nothing is reported after it", async (t) => {
  const home = scratchHome(t);
  const pidFile = join(home, "pid");
  const login = startAgentLogin(withFake(kimiRuntimeDef, "fake-acp-agent.mjs", { FAKE_ACP_LOGIN: "hang", FAKE_ACP_LOGIN_PID_FILE: pidFile }), { homeOverride: home });
  const seen: AgentLoginEvent[] = [];
  login.onEvent((event) => seen.push(event));
  const pid = Number(await waitForFile(pidFile));
  login.cancel();
  await waitUntilDead(pid);
  assert.equal(seen.some(isEnd), false);
});

test("a login nobody finishes is given up after its timeout, and the CLI is stopped", async (t) => {
  const home = scratchHome(t);
  const pidFile = join(home, "pid");
  const login = startAgentLogin(withFake(kimiRuntimeDef, "fake-acp-agent.mjs", { FAKE_ACP_LOGIN: "hang", FAKE_ACP_LOGIN_PID_FILE: pidFile }), {
    homeOverride: home,
    timeoutMs: 300,
  });
  t.after(() => login.cancel());
  const last = (await collect(login, isEnd)).at(-1);
  assert.deepEqual(last, { type: "failed", detail: "the sign-in timed out" });
  await waitUntilDead(Number(await waitForFile(pidFile)));
});

test("rpc-device: the app-server's device code becomes the prompt, and its completion signs in", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(codexRuntimeDef, "fake-codex-app-server.mjs"), { homeOverride: home });
  t.after(() => login.cancel());
  const events = await collect(login, isEnd);
  assert.deepEqual(
    events.find((event) => event.type === "prompt"),
    { type: "prompt", prompt: { url: "https://auth.openai.com/codex/device", userCode: "FAKE-CODEX", expiresInSec: 900 }, input: "none" },
  );
  assert.equal(events.at(-1)?.type, "succeeded");
});

test("rpc-device: a completion that failed is a failure with the app-server's error", async (t) => {
  const home = scratchHome(t);
  const login = startAgentLogin(withFake(codexRuntimeDef, "fake-codex-app-server.mjs", { FAKE_CODEX_LOGIN: "deny" }), { homeOverride: home });
  t.after(() => login.cancel());
  assert.deepEqual((await collect(login, isEnd)).at(-1), { type: "failed", detail: "access_denied" });
});

test("rpc-device: cancel tells the app-server to cancel that login before stopping it", async (t) => {
  const home = scratchHome(t);
  const requests = join(home, "requests.jsonl");
  const pidFile = join(home, "pid");
  const login = startAgentLogin(
    withFake(codexRuntimeDef, "fake-codex-app-server.mjs", { FAKE_CODEX_LOGIN: "hang", FAKE_CODEX_REQUESTS: requests, FAKE_CODEX_PID_FILE: pidFile }),
    { homeOverride: home },
  );
  await collect(login, (event) => event.type === "prompt");
  login.cancel();
  await waitUntilDead(Number((await waitForFile(pidFile)).trim()));
  const methods = readFileSync(requests, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { method: string }).method);
  assert.deepEqual(methods.slice(-2), ["account/login/start", "account/login/cancel"]);
});

test("splitTrailingEscape holds back only a sequence the pipe cut, never plain text after a stray ESC", () => {
  assert.deepEqual(splitTrailingEscape("visit: \x1b]8;;https://a.te"), ["visit: ", "\x1b]8;;https://a.te"]);
  assert.deepEqual(splitTrailingEscape("bold \x1b[1"), ["bold ", "\x1b[1"]);
  assert.deepEqual(splitTrailingEscape("done \x1b[0m"), ["done \x1b[0m", ""]);
  assert.deepEqual(splitTrailingEscape("link \x1b]8;;https://a.test\x07end"), ["link \x1b]8;;https://a.test\x07end", ""]);
  // Joined back, the cut sequence strips clean.
  const [first, held] = splitTrailingEscape("visit: \x1b]8;;https://a.te");
  assert.equal(stripTerminalCodes(first + stripTerminalCodes(held + "st\x07https://a.test\x1b]8;;\x07\n")), "visit: https://a.test\n");
});
