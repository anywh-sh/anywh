import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readUserMcpServers, sweepStaleAgentWorkerMcpFiles, writeAgentWorkerMcpFile } from "./agentWorker.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "anywh-agent-worker-test-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("readUserMcpServers: reads <home>/.claude.json", async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { posthog: { type: "http", url: "https://example.test" } } }));
    assert.deepEqual(Object.keys(await readUserMcpServers(home, undefined, {})), ["posthog"]);
  });
});

test("readUserMcpServers: a home with no ~/.claude.json has no user servers", async () => {
  await withHome(async (home) => assert.deepEqual(await readUserMcpServers(home, undefined, {}), {}));
});

test("readUserMcpServers: a corrupt file has no user servers instead of failing the spawn", async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, ".claude.json"), "{ truncated");
    assert.deepEqual(await readUserMcpServers(home, undefined, {}), {});
  });
});

test("readUserMcpServers: CLAUDE_CONFIG_DIR, when set, is where the CLI keeps .claude.json", async () => {
  await withHome(async (home) => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fromHome: { command: "x" } } }));
    await withHome(async (configDir) => {
      writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: { fromConfigDir: { command: "x" } } }));
      assert.deepEqual(Object.keys(await readUserMcpServers(home, undefined, { CLAUDE_CONFIG_DIR: configDir })), ["fromConfigDir"]);
    });
  });
});

test("readUserMcpServers: honours the directory's disabled list", async () => {
  await withHome(async (home) => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { on: { command: "x" }, off: { command: "y" } }, projects: { "/repo": { disabledMcpServers: ["off"] } } }),
    );
    assert.deepEqual(Object.keys(await readUserMcpServers(home, "/repo", {})), ["on"]);
  });
});

test("readUserMcpServers: a changed file is picked up (cache is keyed on mtime and size)", async () => {
  await withHome(async (home) => {
    const file = join(home, ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { first: { command: "x" } } }));
    assert.deepEqual(Object.keys(await readUserMcpServers(home, undefined, {})), ["first"]);
    // Same size, different content, mtime moved: must not serve the stale copy.
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.deepEqual(Object.keys(await readUserMcpServers(home, undefined, {})), ["other"]);
  });
});

test("writeAgentWorkerMcpFile: private dir and file, content intact, gone after remove()", async () => {
  const file = await writeAgentWorkerMcpFile('{"mcpServers":{}}');
  try {
    assert.equal(readFileSync(file.path, "utf8"), '{"mcpServers":{}}');
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file.path)).mode & 0o777, 0o700);
  } finally {
    await file.remove();
  }
  assert.equal(existsSync(file.path), false);
  assert.equal(existsSync(dirname(file.path)), false);
  await file.remove(); // idempotent
});

test("sweepStaleAgentWorkerMcpFiles: removes a dir whose owner is gone, keeps live owners' dirs", async () => {
  // A pid that certainly belonged to a process and no longer does.
  const finished = spawnSync(process.execPath, ["-e", ""]);
  const deadPid = finished.pid;
  const deadDir = mkdtempSync(join(tmpdir(), `anywh-worker-mcp-${String(deadPid)}-`));
  writeFileSync(join(deadDir, "mcp.json"), "{}");
  const mine = await writeAgentWorkerMcpFile("{}");
  const parentDir = mkdtempSync(join(tmpdir(), `anywh-worker-mcp-${String(process.ppid)}-`));
  try {
    await sweepStaleAgentWorkerMcpFiles();
    assert.equal(existsSync(deadDir), false);
    assert.equal(existsSync(mine.path), true, "this process's own dir is never swept");
    assert.equal(existsSync(parentDir), true, "another live process's dir is never swept, however old");
  } finally {
    await mine.remove();
    rmSync(deadDir, { recursive: true, force: true });
    rmSync(parentDir, { recursive: true, force: true });
  }
});
