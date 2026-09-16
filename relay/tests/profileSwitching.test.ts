import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Server } from "node:net";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

// Real integration test (.anywh/skills/tests/SKILL.md): exercises the
// `/control/profiles` HTTP surface (client/src/hooks/useProfileSync.ts polls
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
