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

// The boot-time runtimes/detection.ts probe (server.ts) runs in parallel
// with httpServer.listen, so `agents` can genuinely be `[]` for a request
// that lands before it resolves — collectUntil's polling loop is the fix,
// same "no arbitrary sleep" rule as everywhere else this doctrine applies.
async function waitForAgents(): Promise<{ id: string; capabilities: Record<string, string> }[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = (await (await fetch(httpUrl("/host-info"))).json()) as { agents: { id: string; capabilities: Record<string, string> }[] };
    if (body.agents.length > 0) return body.agents;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for /host-info's agents to be populated");
}

test("GET /host-info: agents lists claude (detected against the fake binary), with its declared capabilities", async () => {
  const agents = await waitForAgents();
  // Not asserted as the WHOLE list: unlike Claude (AGENT_BIN points this
  // whole suite at the fake binary), Codex's `identity.bin` is the literal
  // `"codex"` with no test-time override — on a machine that happens to
  // have the real CLI installed (the author's own, used for the live smoke
  // tests documented on runtimes/defs/codex.ts), detection genuinely finds
  // it and `agents` legitimately grows a second entry. What this test
  // actually characterizes is Claude's own capabilities passing through
  // detection unchanged, not the total count.
  const claude = agents.find((agent) => agent.id === "claude");
  assert.ok(claude, `expected "claude" among detected agents, got: ${JSON.stringify(agents)}`);
  // Pass-through of the def's own capabilities, not something detection
  // infers from the binary.
  assert.equal(claude.capabilities.approvalPrompt, "bridged");
  assert.equal(claude.capabilities.thinking, "native");
});
