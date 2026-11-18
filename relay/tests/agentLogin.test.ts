import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test: the `/agent-login` socket against a running relay,
// driving the fake `claude`'s `auth login` (Claude Code 2.1.323's prompt with
// no terminal; accepts only `good-code`, and logs the fake in when it does).

let server: TestServer;
let scratch: string;
let loggedOutFile: string;
let loginEnvFile: string;

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "anywh-agent-login-"));
  loggedOutFile = join(scratch, "claude-logged-out");
  loginEnvFile = join(scratch, "login-env.json");
  process.env.FAKE_CLAUDE_LOGGED_OUT_FILE = loggedOutFile;
  process.env.FAKE_CLAUDE_LOGIN_ENV_FILE = loginEnvFile;
  server = await startTestServer();
});

after(async () => {
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Frame {
  type: string;
  url?: string;
  input?: string;
  userCode?: string;
  account?: string;
  plan?: string;
  reason?: string;
  detail?: string;
}

/** Frames until `predicate` holds; rejects if the socket closes first. */
function openLogin(query: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/agent-login?${query}`);
  const frames: Frame[] = [];
  const waiters: { predicate: (frames: Frame[]) => boolean; resolve: () => void; reject: (error: Error) => void }[] = [];
  let closed = false;
  socket.on("message", (raw: Buffer) => {
    frames.push(JSON.parse(raw.toString()) as Frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frames)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  const closedPromise = new Promise<void>((resolveClosed) =>
    socket.on("close", () => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`socket closed; got ${JSON.stringify(frames)}`));
      resolveClosed();
    }),
  );
  return {
    socket,
    frames,
    closed: () => closedPromise,
    isClosed: () => closed,
    until: (predicate: (frames: Frame[]) => boolean) =>
      new Promise<void>((resolveWait, reject) => {
        if (predicate(frames)) return resolveWait();
        if (closed) return reject(new Error(`socket closed; got ${JSON.stringify(frames)}`));
        waiters.push({ predicate, resolve: resolveWait, reject });
      }),
  };
}

const has = (type: string) => (frames: Frame[]) => frames.some((frame) => frame.type === type);
const frame = (frames: Frame[], type: string) => frames.find((each) => each.type === type);

/** Everything the relay logs while `run` runs. */
async function capturingLogs(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      original[level](...args);
    };
  }
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

test("signs a logged-out agent in: prompt out, pasted code in, the account back", async () => {
  writeFileSync(loggedOutFile, "");
  const login = openLogin("runtime=claude");
  await login.until(has("prompt"));
  const prompt = frame(login.frames, "prompt");
  assert.equal(prompt?.url, "https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=fake");
  assert.equal(prompt?.input, "code");

  login.socket.send(JSON.stringify({ type: "code", value: "good-code" }));
  await login.until(has("done"));
  assert.deepEqual(frame(login.frames, "done"), { type: "done", account: "fake@anywh.test", plan: "pro" });
  await login.closed();
  assert.equal(existsSync(loggedOutFile), false, "the fake CLI is logged in now");
});

test("runs under the relay's own HOME by default, with the browser opener disabled", async () => {
  rmSync(loginEnvFile, { force: true });
  const login = openLogin("runtime=claude");
  await login.until(has("prompt"));
  const env = JSON.parse(readFileSync(loginEnvFile, "utf8")) as NodeJS.ProcessEnv;
  assert.equal(env.HOME, server.homeDir);
  assert.equal(env.BROWSER, "true");
  login.socket.close();
  await login.closed();
});

test("a profile being created signs in under its own absolute HOME; a relative one is refused", async () => {
  rmSync(loginEnvFile, { force: true });
  const newHome = mkdtempSync(join(tmpdir(), "anywh-new-profile-home-"));
  const login = openLogin(`runtime=claude&home=${encodeURIComponent(newHome)}`);
  await login.until(has("prompt"));
  assert.equal((JSON.parse(readFileSync(loginEnvFile, "utf8")) as NodeJS.ProcessEnv).HOME, newHome);
  login.socket.close();
  await login.closed();
  rmSync(newHome, { recursive: true, force: true });

  const relative = openLogin("runtime=claude&home=some/dir");
  await relative.closed();
  assert.deepEqual(relative.frames, [{ type: "error", reason: "bad-home" }]);
});

test("a refused code is reported as rejected, and the code itself never reaches the relay's log", async () => {
  const logs = await capturingLogs(async () => {
    const login = openLogin("runtime=claude");
    await login.until(has("prompt"));
    login.socket.send(JSON.stringify({ type: "code", value: "wrong-secret#4271" }));
    await login.until(has("rejected"));
    assert.match(frame(login.frames, "rejected")?.detail ?? "", /wasn't accepted/);
    await login.closed();
  });
  assert.doesNotMatch(logs, /wrong-secret#4271/);
  assert.match(logs, /claude login: code rejected/);
});

test("a second login for the same agent takes over: the first is told it was superseded", async () => {
  const first = openLogin("runtime=claude");
  await first.until(has("prompt"));
  const second = openLogin("runtime=claude");
  await first.until(has("error"));
  assert.equal(frame(first.frames, "error")?.reason, "superseded");
  await second.until(has("prompt"));
  second.socket.close();
  await Promise.all([first.closed(), second.closed()]);
});

test("an unknown runtime is refused with a reason", async () => {
  const unknown = openLogin("runtime=nope");
  await unknown.closed();
  assert.deepEqual(unknown.frames, [{ type: "error", reason: "unknown-runtime" }]);
});

test("signing out runs the agent's own logout, and the agent reads signed out after it", async () => {
  rmSync(loggedOutFile, { force: true });
  const response = await fetch(`http://127.0.0.1:${server.port}/control/agents/claude/logout`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loggedIn: false });
  assert.equal(existsSync(loggedOutFile), true, "the fake CLI's own logout ran");
});

test("an agent with no sign-out is refused, and an unknown one is not found", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/control/agents/kimi/logout`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/control/agents/nope/logout`, { method: "POST" })).status, 404);
});

test("a profile draft signs in under its own Claude config folder and the real HOME, never this relay's account", async () => {
  rmSync(loginEnvFile, { force: true });
  process.env.CLAUDE_CONFIG_DIR = join(scratch, "this-relays-own-claude");
  try {
    const draft = (await (await fetch(`http://127.0.0.1:${server.port}/control/profiles/draft`, { method: "POST", body: JSON.stringify({ label: "Login draft" }) })).json()) as { id: string };
    const login = openLogin(`runtime=claude&profile=${draft.id}`);
    await login.until(has("prompt"));
    const env = JSON.parse(readFileSync(loginEnvFile, "utf8")) as NodeJS.ProcessEnv;
    assert.equal(env.CLAUDE_CONFIG_DIR, join(server.profilesDir, draft.id, "claude"));
    assert.equal(env.CODEX_HOME, join(server.profilesDir, draft.id, "codex"));
    // Not the relay's RELAY_HOME_OVERRIDE: a draft keeps the real $HOME.
    assert.notEqual(env.HOME, server.homeDir);
    login.socket.close();
    await login.closed();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  const unknown = openLogin("runtime=claude&profile=no-such-profile");
  await unknown.closed();
  assert.deepEqual(unknown.frames, [{ type: "error", reason: "unknown-profile" }]);
});
