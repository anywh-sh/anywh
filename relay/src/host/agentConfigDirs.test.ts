import { test } from "node:test";
import assert from "node:assert/strict";
import { agentConfigDir, configDirsFromEnv, envForTarget, resolveAgentPath } from "./agentConfigDirs.js";

const HOME = "/home/u";

test("without config-dir variables every path stays under the home", () => {
  const env = {};
  assert.equal(resolveAgentPath(HOME, ".claude/projects/x/y.jsonl", env), "/home/u/.claude/projects/x/y.jsonl");
  assert.equal(resolveAgentPath(HOME, ".claude.json", env), "/home/u/.claude.json");
  assert.equal(resolveAgentPath(HOME, ".codex/config.toml", env), "/home/u/.codex/config.toml");
  assert.equal(agentConfigDir("kimi", HOME, env), "/home/u/.kimi-code");
});

test("a config-dir variable moves the agent's folder and Claude's sibling .claude.json", () => {
  const env = { CLAUDE_CONFIG_DIR: "/p/claude", CODEX_HOME: "/p/codex", KIMI_CODE_HOME: "/p/kimi" };
  assert.equal(resolveAgentPath(HOME, ".claude/projects/x/y.jsonl", env), "/p/claude/projects/x/y.jsonl");
  assert.equal(resolveAgentPath(HOME, ".claude", env), "/p/claude");
  assert.equal(resolveAgentPath(HOME, ".claude.json", env), "/p/claude/.claude.json");
  assert.equal(resolveAgentPath(HOME, ".codex/config.toml", env), "/p/codex/config.toml");
  assert.equal(resolveAgentPath(HOME, ".kimi-code/mcp.json", env), "/p/kimi/mcp.json");
});

test("paths outside every agent's folder stay under the home, even with the variables set", () => {
  const env = { CLAUDE_CONFIG_DIR: "/p/claude" };
  assert.equal(resolveAgentPath(HOME, ".agents/AGENTS.md", env), "/home/u/.agents/AGENTS.md");
  // A prefix match on the name is not a match on the folder.
  assert.equal(resolveAgentPath(HOME, ".claude-other/x", env), "/home/u/.claude-other/x");
  // `.claude.json` is a sibling file only at the top level.
  assert.equal(resolveAgentPath(HOME, "nested/.claude.json", env), "/home/u/nested/.claude.json");
});

test("an empty variable counts as unset, as the CLIs treat it", () => {
  assert.equal(resolveAgentPath(HOME, ".claude/skills", { CLAUDE_CONFIG_DIR: "  " }), "/home/u/.claude/skills");
  assert.deepEqual(configDirsFromEnv({ CLAUDE_CONFIG_DIR: "", CODEX_HOME: "/c" }), { codex: "/c" });
});

test("a target replaces every config-dir variable instead of inheriting the caller's", () => {
  const caller = { HOME: "/home/u", CLAUDE_CONFIG_DIR: "/mine/claude", CODEX_HOME: "/mine/codex", PATH: "/bin" };
  // A legacy profile: its own HOME, and none of the caller's folders.
  const legacy = envForTarget(caller, { home: "/home/u/.work-home" });
  assert.equal(legacy.HOME, "/home/u/.work-home");
  assert.equal("CLAUDE_CONFIG_DIR" in legacy, false);
  assert.equal("CODEX_HOME" in legacy, false);
  assert.equal(legacy.PATH, "/bin");
  // A config-dir profile: the real HOME, its own folders only.
  const next = envForTarget(caller, { configDirs: { claude: "/other/claude" } });
  assert.equal(next.HOME, "/home/u");
  assert.equal(next.CLAUDE_CONFIG_DIR, "/other/claude");
  assert.equal("CODEX_HOME" in next, false);
  // The caller's env is never touched.
  assert.equal(caller.CLAUDE_CONFIG_DIR, "/mine/claude");
});
