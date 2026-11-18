import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfileSharing, isProfileSharing, SEPARATE_EVERYTHING, type ProfileSharing } from "./profileSharing.js";

// Boundary tier: a real "machine" config tree and a real profile tree in a
// tmpdir, linked and copied for real.

function setup(): { root: string; source: Record<"claude" | "codex" | "kimi", string>; target: Record<"claude" | "codex" | "kimi", string>; claudeJson: string } {
  const root = mkdtempSync(join(tmpdir(), "anywh-sharing-"));
  const source = { claude: join(root, "home/.claude"), codex: join(root, "home/.codex"), kimi: join(root, "home/.kimi-code") };
  const target = { claude: join(root, "p/claude"), codex: join(root, "p/codex"), kimi: join(root, "p/kimi") };
  for (const dir of [...Object.values(source), ...Object.values(target)]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(source.claude, "skills/deploy"), { recursive: true });
  writeFileSync(join(source.claude, "skills/deploy/SKILL.md"), "deploy");
  writeFileSync(join(source.claude, "CLAUDE.md"), "be terse");
  writeFileSync(join(source.claude, "settings.json"), "{}");
  writeFileSync(join(source.codex, "config.toml"), 'model = "x"\n');
  const claudeJson = join(root, "home/.claude.json");
  writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { email: "personal@x" }, mcpServers: { sentry: { command: "s" }, linear: { command: "l" } } }));
  return { root, source, target, claudeJson };
}

const all = (mode: ProfileSharing["mcp"]): ProfileSharing => ({ instructions: mode, preferences: mode, mcp: mode });

test("separate leaves the profile empty and needs nothing at runtime", () => {
  const { root, source, target, claudeJson } = setup();
  try {
    assert.deepEqual(applyProfileSharing(SEPARATE_EVERYTHING, target, source, claudeJson), {});
    assert.throws(() => lstatSync(join(target.claude, "CLAUDE.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared links every entry to the machine's own, creates missing folders there, and names Claude's MCP file", () => {
  const { root, source, target, claudeJson } = setup();
  try {
    const env = applyProfileSharing(all("shared"), target, source, claudeJson);
    assert.deepEqual(env, { ANYWH_CLAUDE_SHARED_MCP: claudeJson });
    assert.equal(readlinkSync(join(target.claude, "CLAUDE.md")), join(source.claude, "CLAUDE.md"));
    assert.equal(readlinkSync(join(target.claude, "skills")), join(source.claude, "skills"));
    // Missing on the machine: created there, so both sides can add to it.
    assert.ok(lstatSync(join(source.claude, "agents")).isDirectory());
    assert.ok(lstatSync(join(target.claude, "agents")).isSymbolicLink());
    // Codex keeps preferences and servers in one file, which follows MCP.
    assert.equal(readlinkSync(join(target.codex, "config.toml")), join(source.codex, "config.toml"));
    // Kimi's config.toml is its account: never linked.
    assert.throws(() => lstatSync(join(target.kimi, "config.toml")));
    // A second run is a no-op, not an error.
    applyProfileSharing(all("shared"), target, source, claudeJson);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy takes a one-time copy and merges Claude's servers without touching the profile's own account", () => {
  const { root, source, target, claudeJson } = setup();
  try {
    // The profile's Claude already signed in, and has a server of its own.
    writeFileSync(join(target.claude, ".claude.json"), JSON.stringify({ oauthAccount: { email: "work@x" }, mcpServers: { sentry: { command: "work-sentry" } } }));
    assert.deepEqual(applyProfileSharing(all("copy"), target, source, claudeJson), {});
    assert.equal(lstatSync(join(target.claude, "CLAUDE.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(target.claude, "skills/deploy/SKILL.md"), "utf8"), "deploy");
    const merged = JSON.parse(readFileSync(join(target.claude, ".claude.json"), "utf8")) as { oauthAccount: { email: string }; mcpServers: Record<string, { command: string }> };
    assert.equal(merged.oauthAccount.email, "work@x");
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["linear", "sentry"]);
    assert.equal(merged.mcpServers.sentry.command, "work-sentry", "the profile's own server wins");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a share never deletes what the profile already wrote", () => {
  const { root, source, target, claudeJson } = setup();
  try {
    mkdirSync(join(target.claude, "skills/mine"), { recursive: true });
    writeFileSync(join(target.claude, "skills/mine/SKILL.md"), "mine");
    applyProfileSharing({ ...SEPARATE_EVERYTHING, instructions: "shared" }, target, source, claudeJson);
    assert.equal(readFileSync(join(target.claude, "skills/mine/SKILL.md"), "utf8"), "mine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isProfileSharing accepts the three categories with a known mode each", () => {
  assert.equal(isProfileSharing(SEPARATE_EVERYTHING), true);
  assert.equal(isProfileSharing({ instructions: "shared", preferences: "copy", mcp: "separate" }), true);
  assert.equal(isProfileSharing({ instructions: "shared", preferences: "copy" }), false);
  assert.equal(isProfileSharing({ instructions: "linked", preferences: "copy", mcp: "separate" }), false);
});
