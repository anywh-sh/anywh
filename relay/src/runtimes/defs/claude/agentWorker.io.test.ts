import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserMcpServers } from "./agentWorker.js";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "anywh-agent-worker-test-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("readUserMcpServers: reads <home>/.claude.json", () => {
  withHome((home) => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { posthog: { type: "http", url: "https://example.test" } } }));
    assert.deepEqual(Object.keys(readUserMcpServers(home)), ["posthog"]);
  });
});

test("readUserMcpServers: a home with no ~/.claude.json has no user servers", () => {
  withHome((home) => assert.deepEqual(readUserMcpServers(home), {}));
});

test("readUserMcpServers: a corrupt file has no user servers instead of failing the spawn", () => {
  withHome((home) => {
    writeFileSync(join(home, ".claude.json"), "{ truncated");
    assert.deepEqual(readUserMcpServers(home), {});
  });
});

test("readUserMcpServers: CLAUDE_CONFIG_DIR, when set, is where the CLI keeps .claude.json", () => {
  withHome((home) => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fromHome: { command: "x" } } }));
    withHome((configDir) => {
      writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: { fromConfigDir: { command: "x" } } }));
      assert.deepEqual(Object.keys(readUserMcpServers(home, { CLAUDE_CONFIG_DIR: configDir })), ["fromConfigDir"]);
    });
  });
});
