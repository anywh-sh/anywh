import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): `GET /host-info`
// served over a real HTTP connection, whose peer address is
// therefore genuinely loopback — exactly the case editorHostInfo.test.ts's
// unit tests can only simulate. The downgrade branch (declared LOCAL but a
// non-loopback peer) isn't reachable through this harness, since a fetch
// from the test process itself is always loopback; that branch is covered
// by the pure-function unit tests instead.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  delete process.env.ANYWH_EDITOR_LOCAL;
  delete process.env.ANYWH_EDITOR_SSH;
});

afterEach(() => {
  delete process.env.ANYWH_EDITOR_LOCAL;
  delete process.env.ANYWH_EDITOR_SSH;
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

test("GET /host-info: both env vars absent hides the feature", async () => {
  const body = (await (await fetch(httpUrl("/host-info"))).json()) as {
    hostname: string;
    platform: string;
    editor: unknown;
    version: unknown;
  };
  assert.equal(body.hostname, hostname());
  assert.equal(body.platform, process.platform);
  assert.equal(body.editor, null);
  // MAJOR.MINOR.PATCH straight from package.json — not asserted against a
  // literal here, which would just be this same file duplicated and one
  // more place to forget on the next version bump.
  assert.match(body.version as string, /^\d+\.\d+\.\d+$/);
});

test("GET /host-info: ANYWH_EDITOR_LOCAL=1 resolves to local for a real loopback peer", async () => {
  process.env.ANYWH_EDITOR_LOCAL = "1";
  const body = (await (await fetch(httpUrl("/host-info"))).json()) as { editor: unknown };
  assert.deepEqual(body.editor, { kind: "local" });
});

test("GET /host-info: ANYWH_EDITOR_SSH describes the ssh target", async () => {
  process.env.ANYWH_EDITOR_SSH = "wil@debian-headless:2222";
  const body = (await (await fetch(httpUrl("/host-info"))).json()) as { editor: unknown };
  assert.deepEqual(body.editor, { kind: "ssh", user: "wil", host: "debian-headless", port: 2222 });
});
