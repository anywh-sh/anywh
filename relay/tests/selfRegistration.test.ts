import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./helpers/ports.js";
import { spawnRelay } from "./helpers/spawnedServer.js";

function tempEnvDir(): { root: string; envDir: string } {
  const root = mkdtempSync(join(tmpdir(), "anywh-self-register-"));
  return { root, envDir: join(root, "env") };
}

test("a relay that cannot bind its port never self-registers as default", async () => {
  const { root, envDir } = tempEnvDir();
  const port = await getFreePort();
  const blocker = createServer();
  await new Promise<void>((resolveListen) => blocker.listen(port, "127.0.0.1", resolveListen));
  try {
    // A fixed RELAY_PORT means one attempt: the child dies on EADDRINUSE and
    // the helper rejects with its output.
    await assert.rejects(spawnRelay({ RELAY_PORT: String(port), ANYWH_ENV_DIR: envDir }), /EADDRINUSE/);
    assert.equal(existsSync(join(envDir, "default.env")), false);
  } finally {
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relay that binds its port self-registers as default in an empty env dir", async () => {
  const { root, envDir } = tempEnvDir();
  const server = await spawnRelay({ ANYWH_ENV_DIR: envDir });
  try {
    const env = readFileSync(join(envDir, "default.env"), "utf8");
    assert.match(env, new RegExp(`^RELAY_PORT=${server.port}$`, "m"));
    assert.match(env, /^RELAY_HOST=127\.0\.0\.1$/m);
  } finally {
    server.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relay that binds its port replaces a stale unregistered default.env", async () => {
  const { root, envDir } = tempEnvDir();
  mkdirSync(envDir, { recursive: true });
  const stalePort = await getFreePort();
  writeFileSync(join(envDir, "default.env"), `RELAY_PORT=${stalePort}\nRELAY_HOST=127.0.0.1\n`);
  const server = await spawnRelay({ ANYWH_ENV_DIR: envDir });
  try {
    // Replacing waits on a port probe, so it lands after the "listening" line.
    const deadline = Date.now() + 10_000;
    while (!server.output.join("").includes("replaced a stale default.env") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.match(server.output.join(""), /replaced a stale default\.env/);
    assert.match(readFileSync(join(envDir, "default.env"), "utf8"), new RegExp(`^RELAY_PORT=${server.port}$`, "m"));

    const { profiles } = (await (await fetch(`http://127.0.0.1:${server.port}/control/profiles`)).json()) as {
      profiles: { id: string; port: number; running: boolean }[];
    };
    const registered = profiles.find((profile) => profile.id === "default");
    assert.equal(registered?.port, server.port);
    assert.equal(registered?.running, true);
  } finally {
    server.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
