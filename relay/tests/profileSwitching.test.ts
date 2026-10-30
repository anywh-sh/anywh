import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Server } from "node:net";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test (.anywh/skills/tests/SKILL.md): exercises the
// `/control/profiles` HTTP surface (client/src/hooks/relay/useProfileSync.ts polls
// this to learn what profiles exist on a host, which is the "switching
// between profiles" flow's network-crossing half) against the real
// profileRegistry.ts, real filesystem, and a REAL second listening socket to
// prove `running` reflects an actual live probe (isPortOpen), not just file
// presence — nothing here is mocked beyond the one sanctioned `claude`
// boundary the primary relay instance itself needs.

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

function httpUrl(path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function getFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address !== null) {
        resolve({ server: probe, port: address.port });
      } else {
        reject(new Error("could not determine a free port"));
      }
    });
  });
}

test("GET /control/profiles reports a second profile's running state from a real live probe, and PATCH/DELETE round-trip through the real registry files", async () => {
  // Plants a second profile's `.env` exactly like `add-profile.sh` would
  // have (relay/src/profileRegistry.ts's `listProfiles` only cares about the
  // file existing, not who wrote it) — pointed at a real listening socket so
  // `isPortOpen` genuinely has something to find.
  const { server: secondListener, port: secondPort } = await getFreePort();
  writeFileSync(join(server.envDir, "trabalho.env"), `RELAY_PORT=${secondPort}\nRELAY_HOST=127.0.0.1\n`);

  const listedRunning = (await (await fetch(httpUrl("/control/profiles"))).json()) as {
    profiles: { id: string; running: boolean; label: string }[];
  };
  const trabalho = listedRunning.profiles.find((profile) => profile.id === "trabalho");
  assert.ok(trabalho, "the planted profile should show up in the list");
  assert.equal(trabalho.running, true, "a profile whose port is genuinely open should report running: true");

  // Same profile, port now closed — `running` must flip to false. This is
  // the real invariant behind "profile switching": the client's picker
  // (useProfileSync) trusts this flag to decide whether a profile is
  // reachable right now, not merely registered.
  await new Promise<void>((resolveClose) => secondListener.close(() => resolveClose()));
  const listedDown = (await (await fetch(httpUrl("/control/profiles"))).json()) as {
    profiles: { id: string; running: boolean }[];
  };
  assert.equal(listedDown.profiles.find((profile) => profile.id === "trabalho")?.running, false);

  const patchResponse = await fetch(httpUrl("/control/profiles/trabalho"), {
    method: "PATCH",
    body: JSON.stringify({ label: "Trabalho renomeado", colorIndex: 2 }),
  });
  assert.equal(patchResponse.status, 200);

  const listedAfterPatch = (await (await fetch(httpUrl("/control/profiles"))).json()) as {
    profiles: { id: string; label: string; colorIndex: number }[];
  };
  const patched = listedAfterPatch.profiles.find((profile) => profile.id === "trabalho");
  assert.equal(patched?.label, "Trabalho renomeado");
  assert.equal(patched?.colorIndex, 2);

  const systemctlArgv = join(server.envDir, "..", "systemctl-argv.jsonl");
  process.env.FAKE_SYSTEMCTL_ARGV_FILE = systemctlArgv;
  // The profile's agent host data: registry (agent specs, which can hold
  // MCP secrets) and logs. Must not outlive the profile.
  const hostData = join(process.env.ANYWH_SESSIONS_ROOT!, "trabalho-agent-host");
  mkdirSync(join(hostData, "logs"), { recursive: true });
  writeFileSync(join(hostData, "registry.json"), "{}");
  writeFileSync(join(hostData, ".anywh-agent-host"), "trabalho\n");
  // Stopping the host waits for its drain; the delete must not.
  process.env.FAKE_SYSTEMCTL_HOST_DELAY_MS = "3000";
  const deleteStarted = Date.now();
  const deleteResponse = await fetch(httpUrl("/control/profiles/trabalho"), { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.ok(Date.now() - deleteStarted < 2000, `delete took ${Date.now() - deleteStarted}ms`);
  assert.equal(existsSync(join(server.envDir, "trabalho.env")), false, "delete should remove the .env file from disk");
  const deadline = Date.now() + 10_000;
  while (existsSync(hostData) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(hostData), false, "the agent host's data goes once the host is stopped");
  delete process.env.FAKE_SYSTEMCTL_HOST_DELAY_MS;
  // Both of the profile's services go: the relay and its agent host.
  const calls = readFileSync(systemctlArgv, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls, [
    ["--user", "disable", "--now", "anywh-relay@trabalho"],
    ["--user", "disable", "--now", "anywh-agent-host@trabalho"],
    ["--user", "is-active", "anywh-agent-host@trabalho"],
  ]);

  const listedAfterDelete = (await (await fetch(httpUrl("/control/profiles"))).json()) as {
    profiles: { id: string }[];
  };
  assert.ok(!listedAfterDelete.profiles.some((profile) => profile.id === "trabalho"));
});

test("POST /control/profiles/validate checks the real fake-claude auth status, and flags a homeOverride already claimed by another profile", async () => {
  const noBody = await fetch(httpUrl("/control/profiles/validate"), { method: "POST" });
  assert.equal(noBody.status, 200, "the whole body is optional");
  const noBodyResult = (await noBody.json()) as { loggedIn: boolean; account?: string; plan?: string; collidesWith?: string };
  assert.equal(noBodyResult.loggedIn, true, "fake-claude.mjs's canned 'auth status --json' reply");
  assert.equal(noBodyResult.account, "fake@anywh.test", "a body naming no runtime still means Claude");
  assert.equal(noBodyResult.plan, "pro");
  assert.equal(noBodyResult.collidesWith, undefined, "no other profile registered yet");

  writeFileSync(join(server.envDir, "existing.env"), "RELAY_PORT=9999\nRELAY_HOME_OVERRIDE=/home/shared\n");

  const collision = await fetch(httpUrl("/control/profiles/validate"), {
    method: "POST",
    body: JSON.stringify({ homeOverride: "/home/shared" }),
  });
  assert.equal(collision.status, 200);
  const collisionResult = (await collision.json()) as { collidesWith?: string };
  assert.equal(collisionResult.collidesWith, "existing", "same normalized homeOverride as the planted profile");

  const noCollision = await fetch(httpUrl("/control/profiles/validate"), {
    method: "POST",
    body: JSON.stringify({ homeOverride: "/home/different" }),
  });
  const noCollisionResult = (await noCollision.json()) as { collidesWith?: string };
  assert.equal(noCollisionResult.collidesWith, undefined);
});

test("POST /control/profiles/validate resolves the runtime it was asked for, and refuses one no def answers to", async () => {
  // The bug this route was carrying: it ran `claude auth status` whatever
  // the caller meant. Naming the runtime explicitly has to reach the same
  // def the default does, and an id the registry doesn't know has to come
  // back as the caller's mistake — never as a silent fallback to Claude,
  // which would report a Codex profile logged in on Claude's session.
  const named = await fetch(httpUrl("/control/profiles/validate"), {
    method: "POST",
    body: JSON.stringify({ runtimeId: "claude" }),
  });
  assert.equal(named.status, 200);
  assert.equal(((await named.json()) as { account?: string }).account, "fake@anywh.test");

  const unknown = await fetch(httpUrl("/control/profiles/validate"), {
    method: "POST",
    body: JSON.stringify({ runtimeId: "not-a-runtime" }),
  });
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as { error: string }).error, /unknown runtime/);
});

test("POST /control/profiles refuses to provision against a runtime no def answers to, before running anything", async () => {
  const response = await fetch(httpUrl("/control/profiles"), {
    method: "POST",
    body: JSON.stringify({ label: "Ghost", runtimeId: "not-a-runtime" }),
  });
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /unknown runtime/);
  const listed = (await (await fetch(httpUrl("/control/profiles"))).json()) as { profiles: { id: string }[] };
  assert.ok(!listed.profiles.some((profile) => profile.id === "ghost"), "a rejected body must not have reached add-profile.sh");
});

interface ListedProfile {
  id: string;
  port: number;
  agentPreference?: { mode: string; fixedAgentId?: string };
  lastUsedAgentId?: string;
}

async function listProfilesOverHttp(): Promise<ListedProfile[]> {
  return ((await (await fetch(httpUrl("/control/profiles"))).json()) as { profiles: ListedProfile[] }).profiles;
}

function patchProfile(id: string, body: unknown): Promise<Response> {
  return fetch(httpUrl(`/control/profiles/${id}`), { method: "PATCH", body: JSON.stringify(body) });
}

test("PATCH /control/profiles/:id stores a default agent preference that GET reports, refuses an agent no def answers to, and null clears it", async () => {
  writeFileSync(join(server.envDir, "lab.env"), "RELAY_PORT=1\nRELAY_HOST=127.0.0.1\n");

  const fixed = await patchProfile("lab", { agentPreference: { mode: "fixed", fixedAgentId: "codex" } });
  assert.equal(fixed.status, 200);
  assert.deepEqual(((await fixed.json()) as ListedProfile).agentPreference, { mode: "fixed", fixedAgentId: "codex" });
  assert.deepEqual((await listProfilesOverHttp()).find((profile) => profile.id === "lab")?.agentPreference, { mode: "fixed", fixedAgentId: "codex" });

  const unknownAgent = await patchProfile("lab", { agentPreference: { mode: "fixed", fixedAgentId: "nonexistent-cli" } });
  assert.equal(unknownAgent.status, 400);
  assert.match(((await unknownAgent.json()) as { error: string }).error, /unknown agent/);
  assert.equal((await patchProfile("lab", { agentPreference: { mode: "always" } })).status, 400, "unknown mode");
  assert.deepEqual((await listProfilesOverHttp()).find((profile) => profile.id === "lab")?.agentPreference, { mode: "fixed", fixedAgentId: "codex" }, "a refused PATCH writes nothing");

  assert.equal((await patchProfile("lab", { agentPreference: null })).status, 200);
  assert.equal((await listProfilesOverHttp()).find((profile) => profile.id === "lab")?.agentPreference, undefined);
});

test("GET /control/profiles derives lastUsedAgentId from real conversations: this relay's own live, another profile's from its sessions file", async () => {
  // Another profile's relay keeps its conversations where its .env says
  // (add-profile.sh always writes RELAY_SESSIONS_FILE); its newest titled
  // conversation is a Codex one.
  const otherSessions = join(server.envDir, "..", "other-sessions.json");
  writeFileSync(
    otherSessions,
    JSON.stringify({
      older: { agentId: "claude", sessionId: {}, title: "Older", cwd: { cwd: server.homeDir, locked: true }, lastActiveAt: 100 },
      newer: { agentId: "codex", sessionId: {}, title: "Newer", cwd: { cwd: server.homeDir, locked: true }, lastActiveAt: 200 },
    }),
  );
  writeFileSync(join(server.envDir, "outro.env"), `RELAY_PORT=2\nRELAY_HOST=127.0.0.1\nRELAY_SESSIONS_FILE=${otherSessions}\n`);

  const before = await listProfilesOverHttp();
  assert.equal(before.find((profile) => profile.id === "outro")?.lastUsedAgentId, "codex");
  const own = before.find((profile) => profile.port === server.port);
  assert.ok(own, `this relay lists its own profile: ${JSON.stringify(before)}`);
  assert.equal(own.lastUsedAgentId, undefined, "no conversation has had a turn yet");

  // A real turn against the fake claude, over the real WebSocket.
  const socket = await connectSession(server.port, "last-used-agent");
  try {
    const ended = collectUntil(socket, isTurnEnded, 15_000);
    sendUserMessage(socket, "hello");
    await ended;
  } finally {
    socket.close();
  }
  const deadline = Date.now() + 10_000;
  let ownAfter: ListedProfile | undefined;
  while (Date.now() < deadline) {
    ownAfter = (await listProfilesOverHttp()).find((profile) => profile.port === server.port);
    if (ownAfter?.lastUsedAgentId) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ownAfter?.lastUsedAgentId, "claude");
});
