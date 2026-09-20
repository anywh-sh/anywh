import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyBundle, readBundle } from "./configHome.js";
import { parseDeclaration } from "./declaration.js";
import { toSnapshot } from "./manifest.js";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import type { AgentRuntimeDef, McpContract } from "../runtimes/types.js";

// Boundary tier (.anywh/skills/tests/SKILL.md): a real directory tree in a
// real tmpdir, read and written for real. The def is a fixture rather than
// the Claude or Codex one on purpose — this proves the *plumbing* obeys
// whatever a def declares, and the two real defs' values are pinned by
// their own tests.

const TOML_MCP: McpContract = {
  kind: "supported",
  declaration: {
    kind: "shared",
    path: ".fixture/config.toml",
    format: "toml",
    serversKey: "mcp_servers",
    portableKeys: ["model", "mcp_servers"],
  },
  loginArgs: (serverName) => ["mcp", "login", serverName],
  loginDriver: "child",
  callback: { kind: "paste-code" },
  needsAuthSignal: { kind: "in-band" },
};

/** A def is built by overriding the real Claude one's `portability`, not
 * by writing a fresh literal: what this file proves is that the plumbing
 * follows whatever a def declares, and borrowing a real def keeps this
 * test from having to state an `exec` plan it doesn't care about (which
 * `architecture.test.ts` rightly forbids outside `runtimes/`). */
function fixtureDef(authoredPaths: readonly string[], mcp: McpContract = TOML_MCP): AgentRuntimeDef {
  return { ...claudeRuntimeDef, identity: { ...claudeRuntimeDef.identity, id: "fixture" }, portability: { authoredPaths, mcp } };
}

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "anywh-config-home-"));
}

function write(home: string, relativePath: string, contents: string): string {
  const absolute = join(home, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

test("readBundle: walks an authored directory to its leaves, keeps paths relative to the home", () => {
  const home = newHome();
  write(home, ".fixture/skills/deploy/SKILL.md", "---\nname: deploy\n---\n");
  write(home, ".fixture/skills/deploy/scripts/run.sh", "#!/bin/sh\necho hi\n");
  write(home, ".fixture/agents/reviewer.md", "review things");
  write(home, ".fixture/untracked/ignored.md", "not an authored path");

  const bundle = readBundle(fixtureDef([".fixture/skills", ".fixture/agents"]), home);
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [".fixture/skills/deploy/SKILL.md", ".fixture/skills/deploy/scripts/run.sh", ".fixture/agents/reviewer.md"],
  );
  assert.equal(Buffer.from(bundle.files[0].contents, "base64").toString("utf8"), "---\nname: deploy\n---\n");
});

test("readBundle: a path the def lists but this machine doesn't have is simply absent", () => {
  const home = newHome();
  write(home, ".fixture/skills/deploy/SKILL.md", "x");
  const bundle = readBundle(fixtureDef([".fixture/skills", ".fixture/agents", ".fixture/commands"]), home);
  assert.equal(bundle.files.length, 1);
  assert.deepEqual(bundle.warnings, [], "a missing optional path is the ordinary case, not a warning");
});

test("readBundle: an empty home has nothing to carry, and says so without failing", () => {
  const snapshot = toSnapshot(readBundle(fixtureDef([".fixture/skills"]), newHome()));
  assert.equal(snapshot.found, false);
  assert.deepEqual(snapshot.files, []);
});

test("readBundle: a symlink is skipped, never followed out of the config home", () => {
  const home = newHome();
  const secrets = newHome();
  write(secrets, "id_rsa", "PRIVATE KEY");
  mkdirSync(join(home, ".fixture/skills"), { recursive: true });
  symlinkSync(join(secrets, "id_rsa"), join(home, ".fixture/skills/stolen"));
  write(home, ".fixture/skills/real.md", "authored");

  const bundle = readBundle(fixtureDef([".fixture/skills"]), home);
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [".fixture/skills/real.md"],
  );
  assert.ok(!JSON.stringify(bundle).includes("PRIVATE KEY"));
});

test("readBundle: the executable bit rides along — a skill's helper script has to stay runnable", () => {
  const home = newHome();
  const script = write(home, ".fixture/skills/deploy/run.sh", "#!/bin/sh\n");
  chmodSync(script, 0o755);
  write(home, ".fixture/skills/deploy/SKILL.md", "x");

  const files = readBundle(fixtureDef([".fixture/skills"]), home).files;
  assert.equal(files.find((file) => file.path.endsWith("run.sh"))?.executable, true);
  assert.equal(files.find((file) => file.path.endsWith("SKILL.md"))?.executable, false);
});

test("readBundle: carries the allowlisted keys of a shared declaration and names its servers", () => {
  const home = newHome();
  write(
    home,
    ".fixture/config.toml",
    'model = "gpt-5.6-terra"\n[projects."/home/someone/x"]\ntrust_level = "trusted"\n[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n',
  );
  const bundle = readBundle(fixtureDef([".fixture/skills"]), home);
  assert.deepEqual(bundle.mcpServers, ["sentry"]);
  assert.deepEqual(Object.keys(bundle.declaration?.values ?? {}).sort(), ["mcp_servers", "model"]);
  assert.ok(!Object.hasOwn(bundle.declaration?.values ?? {}, "projects"));
});

test("readBundle: a runtime with no MCP contract still carries its authored files", () => {
  const home = newHome();
  write(home, ".fixture/skills/x/SKILL.md", "x");
  const bundle = readBundle(fixtureDef([".fixture/skills"], { kind: "none" }), home);
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.declaration, undefined);
  assert.deepEqual(bundle.mcpServers, []);
});

test("readBundle: an absolute path inside a copied JSON file is reported, and the file is carried anyway", () => {
  const home = newHome();
  write(home, ".fixture/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ command: "/home/someone/bin/lint --fix" }] } }));
  const bundle = readBundle(fixtureDef([".fixture/settings.json"]), home);
  assert.equal(bundle.files.length, 1, "warning, never a filter — the destination may genuinely have that path");
  assert.equal(bundle.warnings.length, 1);
  assert.equal(bundle.warnings[0].kind, "absolute-path");
  assert.match(bundle.warnings[0].detail, /\/home\/someone\/bin\/lint/);
});

test("readBundle: a file too large to base64 into a response is reported instead of carried", () => {
  const home = newHome();
  write(home, ".fixture/skills/huge/dataset.bin", "x".repeat(1024 * 1024 + 1));
  write(home, ".fixture/skills/huge/SKILL.md", "x");
  const bundle = readBundle(fixtureDef([".fixture/skills"]), home);
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [".fixture/skills/huge/SKILL.md"],
  );
  assert.equal(bundle.warnings[0].kind, "file-too-large");
});

test("applyBundle: a bundle read from one home reproduces it in another, byte for byte", () => {
  const source = newHome();
  const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  write(source, ".fixture/skills/deploy/SKILL.md", "---\nname: deploy\n---\n");
  writeFileSync(join(source, ".fixture/skills/deploy/logo.png"), binary);
  chmodSync(write(source, ".fixture/skills/deploy/run.sh", "#!/bin/sh\n"), 0o755);
  write(source, ".fixture/config.toml", '[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n');

  const def = fixtureDef([".fixture/skills"]);
  const destination = newHome();
  const result = applyBundle(def, destination, readBundle(def, source));

  assert.deepEqual(result.rejected, []);
  assert.equal(readFileSync(join(destination, ".fixture/skills/deploy/SKILL.md"), "utf8"), "---\nname: deploy\n---\n");
  assert.deepEqual(readFileSync(join(destination, ".fixture/skills/deploy/logo.png")), binary, "a binary asset survives the round trip");
  assert.equal((statSync(join(destination, ".fixture/skills/deploy/run.sh")).mode & 0o100) !== 0, true);
  assert.deepEqual(parseDeclaration(readFileSync(join(destination, ".fixture/config.toml"), "utf8"), "toml").mcp_servers, {
    sentry: { url: "https://mcp.sentry.dev/mcp" },
  });
});

test("applyBundle: merges into the destination's declaration instead of replacing the file", () => {
  const source = newHome();
  write(source, ".fixture/config.toml", '[mcp_servers.sentry]\nurl = "https://mcp.sentry.dev/mcp"\n');
  const destination = newHome();
  write(destination, ".fixture/config.toml", '[projects."/srv/app"]\ntrust_level = "trusted"\n');

  const def = fixtureDef([".fixture/skills"]);
  applyBundle(def, destination, readBundle(def, source));

  const applied = parseDeclaration(readFileSync(join(destination, ".fixture/config.toml"), "utf8"), "toml");
  assert.deepEqual(applied.mcp_servers, { sentry: { url: "https://mcp.sentry.dev/mcp" } });
  assert.deepEqual(applied.projects, { "/srv/app": { trust_level: "trusted" } }, "the destination's own state survives the merge");
});

test("applyBundle: refuses a manifest path that would climb out of the config home", () => {
  // A bundle arrives over HTTP from another machine's relay, so the path
  // inside it is input, not something this relay produced.
  const destination = newHome();
  const result = applyBundle(fixtureDef([".fixture/skills"]), destination, {
    files: [
      { path: "../../.ssh/authorized_keys", contents: Buffer.from("ssh-rsa AAAA").toString("base64"), executable: false },
      { path: "/etc/cron.d/anywh", contents: Buffer.from("* * * * * root sh").toString("base64"), executable: false },
      { path: ".fixture/skills/ok.md", contents: Buffer.from("fine").toString("base64"), executable: false },
    ],
  });
  assert.deepEqual(result.rejected, ["../../.ssh/authorized_keys", "/etc/cron.d/anywh"]);
  assert.deepEqual(result.written, [".fixture/skills/ok.md"]);
});

test("applyBundle: the def decides where the declaration lands, not the incoming manifest", () => {
  const destination = newHome();
  const def = fixtureDef([".fixture/skills"]);
  applyBundle(def, destination, {
    files: [],
    declaration: { path: ".ssh/config", format: "toml", values: { mcp_servers: { sentry: { url: "https://x" } } } },
  });
  assert.deepEqual(parseDeclaration(readFileSync(join(destination, ".fixture/config.toml"), "utf8"), "toml").mcp_servers, {
    sentry: { url: "https://x" },
  });
});

test("applyBundle: written config is owner-only — this may be a machine someone else can log into", () => {
  const destination = newHome();
  applyBundle(fixtureDef([".fixture/skills"]), destination, {
    files: [{ path: ".fixture/skills/x.md", contents: Buffer.from("x").toString("base64"), executable: false }],
  });
  assert.equal(statSync(join(destination, ".fixture/skills/x.md")).mode & 0o077, 0);
});
