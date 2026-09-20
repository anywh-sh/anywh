import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Server } from "node:net";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

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

  const deleteResponse = await fetch(httpUrl("/control/profiles/trabalho"), { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.equal(existsSync(join(server.envDir, "trabalho.env")), false, "delete should remove the .env file from disk");

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
