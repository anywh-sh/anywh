import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test: the `/mcp-login` socket against a running relay,
// driving the fake `claude` through the same `--no-browser` shape the real
// one has (print a URL, take the redirect back on stdin, report success).
// The fixture refuses without a TTY exactly like the real binary, so this
// also proves the relay honors the def's `loginDriver: "pty"`.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function write(home: string, relativePath: string, contents: string): void {
  const absolute = join(home, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

interface LoginFrame {
  type: string;
  data?: string;
  code?: number | null;
  error?: string;
}

/** Opens the socket and collects frames until `predicate` is satisfied or
 * the socket closes — explicit synchronization, never a fixed sleep (see
 * the testing doctrine's "Determinism"). */
function openLogin(query: string): { socket: WebSocket; frames: LoginFrame[]; until: (predicate: (frames: LoginFrame[]) => boolean) => Promise<void> } {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/mcp-login?${query}`);
  const frames: LoginFrame[] = [];
  const waiters: { predicate: (frames: LoginFrame[]) => boolean; resolve: () => void; reject: (error: Error) => void }[] = [];
  const check = (): void => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frames)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  socket.on("message", (raw: Buffer) => {
    frames.push(JSON.parse(raw.toString()) as LoginFrame);
    check();
  });
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`socket closed before the expected frame; got ${JSON.stringify(frames)}`));
  });
  return {
    socket,
    frames,
    until: (predicate) =>
      new Promise<void>((resolve, reject) => {
        if (predicate(frames)) {
          resolve();
          return;
        }
        waiters.push({ predicate, resolve, reject });
      }),
  };
}

test("/mcp-login drives the CLI's own login: URL out, pasted redirect in, success back", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-mcp-login-home-"));
  write(home, ".claude.json", JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }));

  const login = openLogin(`runtime=claude&server=sentry&home=${encodeURIComponent(home)}`);
  const output = (): string => login.frames.filter((frame) => frame.type === "data").map((frame) => frame.data ?? "").join("");

  await login.until((frames) => frames.some((frame) => frame.type === "data" && (frame.data ?? "").includes("auth.fake.test")));
  assert.match(output(), /https:\/\/auth\.fake\.test\/authorize\?server=sentry/, "the authorization URL reaches the client as plain text");

  login.socket.send(JSON.stringify({ type: "input", data: "https://localhost:9999/callback?code=abc\r" }));
  await login.until((frames) => frames.some((frame) => frame.type === "exit"));

  assert.match(output(), /Successfully logged in to MCP server 'sentry'/);
  assert.equal(login.frames.find((frame) => frame.type === "exit")?.code, 0);
});

test("/mcp-login refuses an unknown runtime and a relative home instead of spawning anything", async () => {
  for (const query of ["runtime=not-a-runtime&server=sentry", "runtime=claude&server=sentry&home=relative/path", "runtime=claude&server="]) {
    const login = openLogin(query);
    await login.until((frames) => frames.some((frame) => frame.type === "error"));
    assert.ok(login.frames[0].error, query);
    login.socket.close();
  }
});

test("GET /control/portability/mcp: declared servers, flagged by the runtime's own out-of-band signal", async () => {
  const home = mkdtempSync(join(tmpdir(), "anywh-mcp-status-home-"));
  write(home, ".claude.json", JSON.stringify({ mcpServers: { sentry: {}, linear: {} } }));
  write(home, ".claude/mcp-needs-auth-cache.json", JSON.stringify({ linear: { timestamp: 1, id: "x" } }));

  const response = await fetch(`http://127.0.0.1:${server.port}/control/portability/mcp?runtime=claude&home=${encodeURIComponent(home)}`);
  assert.equal(response.status, 200);
  const status = (await response.json()) as { signal: string; loginDriver: string; servers: { name: string; needsAuth: boolean }[] };
  assert.equal(status.signal, "file");
  assert.equal(status.loginDriver, "pty");
  assert.deepEqual(status.servers, [
    { name: "sentry", needsAuth: false },
    { name: "linear", needsAuth: true },
  ]);
});
