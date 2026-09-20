import { test } from "node:test";
import assert from "node:assert/strict";
import { findAbsolutePathValues, isSafeRelativePath, toSnapshot } from "./manifest.js";

test("isSafeRelativePath: accepts what a config home actually holds", () => {
  for (const path of [".claude/skills/deploy/SKILL.md", ".codex/config.toml", ".claude.json", "a/b/c.md"]) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test("isSafeRelativePath: refuses everything that could write outside the home", () => {
  for (const path of ["", "/etc/passwd", "../../.ssh/authorized_keys", ".claude/../../x", "C:\\Windows\\System32\\x", "..", "../x"]) {
    assert.equal(isSafeRelativePath(path), false, path);
  }
});

test("isSafeRelativePath: a `..` that normalizes away is fine — the check is on where it lands", () => {
  assert.equal(isSafeRelativePath(".claude/skills/../agents/x.md"), true);
});

test("findAbsolutePathValues: finds a hook's command however deep it sits", () => {
  const settings = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/home/someone/bin/lint --fix" }] }] } };
  const warnings = findAbsolutePathValues(settings, ".claude/settings.json");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "absolute-path");
  assert.equal(warnings[0].path, ".claude/settings.json");
});

test("findAbsolutePathValues: a Windows path counts too", () => {
  assert.equal(findAbsolutePathValues({ command: "C:\\Users\\someone\\bin\\lint.exe" }, "x.json").length, 1);
});

test("findAbsolutePathValues: ordinary settings don't get flagged", () => {
  // A URL and a bare command name are the overwhelmingly common values
  // here; flagging them would make the warning list noise a user learns
  // to ignore.
  const settings = { model: "opus", url: "https://mcp.example.dev/mcp", command: "npx", enabled: true, count: 3 };
  assert.deepEqual(findAbsolutePathValues(settings, "x.json"), []);
});

test("toSnapshot: drops contents but keeps sizes, so the UI can say what it would carry", () => {
  const snapshot = toSnapshot({
    runtimeId: "fixture",
    files: [{ path: "a.md", contents: "eA==", bytes: 1, executable: false }],
    mcpServers: ["sentry"],
    warnings: [],
  });
  assert.deepEqual(snapshot.files, [{ path: "a.md", bytes: 1 }]);
  assert.equal(snapshot.found, true);
  assert.ok(!JSON.stringify(snapshot).includes("eA=="));
});

test("toSnapshot: a declaration with no authored files still counts as having something to carry", () => {
  const snapshot = toSnapshot({
    runtimeId: "fixture",
    files: [],
    declaration: { path: ".fixture/config.toml", format: "toml", values: { mcp_servers: { sentry: {} } } },
    mcpServers: ["sentry"],
    warnings: [],
  });
  assert.equal(snapshot.found, true, "a setup that is three MCP servers and nothing else is still a setup");
});
