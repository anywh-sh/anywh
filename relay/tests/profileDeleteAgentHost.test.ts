// What deleting a profile does to its agent host's data directory: removed
// only once the host is really stopped, only if it is really a host's
// directory, and never if the profile came back meanwhile.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

let server: TestServer;
const outcomes: string[] = [];
const originalLog = console.log;
const originalError = console.error;

before(async () => {
  server = await startTestServer();
  const capture = (...args: unknown[]): void => {
    const line = args.map(String).join(" ");
    if (line.includes("agent host data")) outcomes.push(line);
  };
  console.log = (...args: unknown[]) => {
    capture(...args);
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    capture(...args);
    originalError(...args);
  };
});

after(async () => {
  console.log = originalLog;
  console.error = originalError;
  await server.close();
});

async function waitForOutcome(id: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = outcomes.find((line) => line.includes(`agent host data of ${id}`));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no outcome for ${id}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function plantProfile(id: string, envExtra = ""): void {
  writeFileSync(join(server.envDir, `${id}.env`), `RELAY_PORT=1\nRELAY_HOST=127.0.0.1\n${envExtra}`);
}

function plantHostData(dir: string, owner: string | undefined): void {
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "registry.json"), "{}");
  if (owner !== undefined) writeFileSync(join(dir, ".anywh-agent-host"), `${owner}\n`);
}

async function deleteProfile(id: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server.port}/control/profiles/${id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
}

const root = (): string => process.env.ANYWH_SESSIONS_ROOT!;

test("a stopped host's marked data directory is removed, wherever the profile's env file (quoted) puts it", async () => {
  const dir = join(root(), "elsewhere", "host-data");
  plantProfile("p1", `ANYWH_AGENT_HOST_DIR="${dir}"\n`);
  plantHostData(dir, "p1");
  await deleteProfile("p1");
  assert.match(await waitForOutcome("p1"), /removed/);
  assert.equal(existsSync(dir), false);
});

test("a directory without the host's marker is never removed", async () => {
  const dir = join(root(), "p2-agent-host");
  plantProfile("p2");
  plantHostData(dir, undefined);
  await deleteProfile("p2");
  assert.match(await waitForOutcome("p2"), /kept/);
  assert.equal(existsSync(join(dir, "registry.json")), true);
});

test("the data stays when stopping the host failed or it is still active", async () => {
  for (const [id, env] of [
    ["p3", { FAKE_SYSTEMCTL_HOST_DISABLE_FAIL: "1" }],
    ["p4", { FAKE_SYSTEMCTL_HOST_STATE: "active" }],
  ] as const) {
    const dir = join(root(), `${id}-agent-host`);
    plantProfile(id);
    plantHostData(dir, id);
    Object.assign(process.env, env);
    try {
      await deleteProfile(id);
      assert.match(await waitForOutcome(id), /kept/);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
    }
    assert.equal(existsSync(join(dir, "registry.json")), true, id);
  }
});

test("the data stays when the profile was created again while its old host was stopping", async () => {
  const dir = join(root(), "p5-agent-host");
  plantProfile("p5");
  plantHostData(dir, "p5");
  process.env.FAKE_SYSTEMCTL_HOST_DELAY_MS = "1500";
  try {
    await deleteProfile("p5");
    plantProfile("p5"); // recreated meanwhile
    assert.match(await waitForOutcome("p5"), /kept/);
  } finally {
    delete process.env.FAKE_SYSTEMCTL_HOST_DELAY_MS;
  }
  assert.equal(existsSync(join(dir, "registry.json")), true);
});

test("a directory marked by another profile's host is never removed (two profiles sharing ANYWH_AGENT_HOST_DIR)", async () => {
  const shared = join(root(), "shared-host-dir");
  plantProfile("p6", `ANYWH_AGENT_HOST_DIR=${shared}\n`);
  plantProfile("p7", `ANYWH_AGENT_HOST_DIR=${shared}\n`);
  plantHostData(shared, "p7");
  await deleteProfile("p6");
  assert.match(await waitForOutcome("p6"), /kept/);
  assert.equal(existsSync(join(shared, "registry.json")), true);
});

test("a marked directory that also holds files a host does not write is never removed", async () => {
  const dir = join(root(), "p8-agent-host");
  plantProfile("p8");
  plantHostData(dir, "p8");
  writeFileSync(join(dir, "notes.txt"), "the user's own file");
  await deleteProfile("p8");
  assert.match(await waitForOutcome("p8"), /kept/);
  assert.equal(existsSync(join(dir, "notes.txt")), true);
});
