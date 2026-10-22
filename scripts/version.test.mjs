import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  crossedMinors,
  findBreakingSurfaces,
  guardVerdict,
  isBreaking,
  latestVersionTag,
  nextVersion,
  planTags,
  foldUntooled,
  parseUnifiedDiff,
  readUpgradeNotes,
  renderChangelog,
} from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("only `!` after the type or a BREAKING CHANGE footer is breaking", () => {
  assert.equal(isBreaking("feat!: drop the v1 wire"), true);
  assert.equal(isBreaking("fix(relay)!: rename the env var"), true);
  assert.equal(isBreaking("feat(relay): add a thing\n\nBREAKING CHANGE: the unit changed"), true);
  assert.equal(isBreaking("feat(relay): add a thing\n\nBREAKING-CHANGE: same"), true);
  assert.equal(isBreaking("feat: a redesign of every screen"), false);
  assert.equal(isBreaking("fix: mention BREAKING CHANGE: inline, not as a footer"), false);
  assert.equal(isBreaking("docs: explain why `feat!:` bumps minor"), false);
});

test("PATCH by default, MINOR on a breaking commit, MAJOR only when asked", () => {
  assert.deepEqual(nextVersion([0, 1, 8], ["feat: x", "fix: y"]), [0, 1, 9]);
  assert.deepEqual(nextVersion([0, 1, 8], ["chore: x"]), [0, 1, 9]);
  assert.deepEqual(nextVersion([0, 1, 8], ["fix: y", "feat!: x"]), [0, 2, 0]);
  assert.deepEqual(nextVersion([1, 4, 2], ["feat!: x"]), [1, 5, 0]); // breaking never becomes MAJOR on its own
  assert.deepEqual(nextVersion([0, 9, 3], ["fix: y"], { major: true }), [1, 0, 0]);
});

test("the base is the highest vX.Y.Z tag, ignoring suffixed ones", () => {
  assert.equal(latestVersionTag(["v0.1.10", "v0.1.9", "v0.1.8-rc.1", "v0.2.0-rc.1", "nightly"]).tag, "v0.1.10");
  assert.equal(latestVersionTag(["v0.1.8-rc.1"]), null);
});

test("crossed minor lines come from the X.Y.0 tags in (previous, target]", () => {
  const tags = ["v0.1.8", "v0.2.0", "v0.2.1", "v0.3.0", "v0.3.1", "v1.0.0", "v1.1.0"];
  assert.deepEqual(crossedMinors(tags, [0, 1, 8], [0, 3, 1]), ["0.2", "0.3"]);
  assert.deepEqual(crossedMinors(tags, [0, 2, 0], [0, 2, 1]), []);
  assert.deepEqual(crossedMinors(tags, [0, 3, 1], [1, 1, 0]), ["1.0", "1.1"]);
});

test("upgrade notes must exist and must not still be a draft", () => {
  const files = { "docs/upgrade-notes/0.2.md": "Update both.\n", "docs/upgrade-notes/0.3.md": "<!-- draft -->\nTBD" };
  const read = (path) => files[path] ?? null;
  assert.deepEqual(readUpgradeNotes("0.2", read), { body: "Update both." });
  assert.match(readUpgradeNotes("0.3", read).problem, /draft/);
  assert.match(readUpgradeNotes("0.4", read).problem, /missing/);
});

test("the changelog lists each commit once, under its first matching section", () => {
  const changelog = renderChangelog([
    { version: "0.2.0", message: "feat(relay)!: version the wire (#71)\n\nbody" },
    { version: "0.2.1", message: "feat: rooms (#154)" },
    { version: "0.2.2", message: "fix(client): scroll (#170)" },
    { version: "0.2.3", message: "test(relay): deflake (#179)" },
  ]);
  assert.equal(
    changelog,
    [
      "### Breaking changes\n\n- feat(relay)!: version the wire (#71) (v0.2.0)",
      "### Features\n\n- feat: rooms (#154) (v0.2.1)",
      "### Fixes\n\n- fix(client): scroll (#170) (v0.2.2)",
      "### Other changes\n\n- test(relay): deflake (#179) (v0.2.3)",
    ].join("\n\n"),
  );
});

const DIFF = `diff --git a/relay/src/protocol/version.ts b/relay/src/protocol/version.ts
index 1..2 100644
--- a/relay/src/protocol/version.ts
+++ b/relay/src/protocol/version.ts
@@ -30 +30 @@
-export const WS_PROTOCOL_VERSION = 3;
+export const WS_PROTOCOL_VERSION = 4;
diff --git a/client/src/components/Thing.tsx b/client/src/components/Thing.tsx
index 1..2 100644
--- a/client/src/components/Thing.tsx
+++ b/client/src/components/Thing.tsx
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;

test("the diff parser keeps each file's changed lines", () => {
  assert.deepEqual(parseUnifiedDiff(DIFF), [
    { path: "relay/src/protocol/version.ts", lines: ["export const WS_PROTOCOL_VERSION = 3;", "export const WS_PROTOCOL_VERSION = 4;"] },
    { path: "client/src/components/Thing.tsx", lines: ["const a = 1;", "const a = 2;"] },
  ]);
});

test("a changed line that starts with -- or ++ is content, not a file header", () => {
  const diff = [
    "diff --git a/relay/src/store.ts b/relay/src/store.ts",
    "index 1..2 100644",
    "--- a/relay/src/store.ts",
    "+++ b/relay/src/store.ts",
    "@@ -10 +10 @@",
    "--- migrate the legacy record",
    "+++counter;",
    "",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [{ path: "relay/src/store.ts", lines: ["-- migrate the legacy record", "++counter;"] }]);
  assert.deepEqual(findBreakingSurfaces(parseUnifiedDiff(diff)).map((hit) => hit.path), ["relay/src/store.ts"]);
});

test("each breaking-sensitive surface is caught, and ordinary changes are not", () => {
  const hit = (path, lines = ["x"]) => findBreakingSurfaces([{ path, lines }]).map((h) => h.path);
  assert.deepEqual(hit("relay/src/protocol/version.ts", ["export const WS_PROTOCOL_VERSION = 4;"]), ["relay/src/protocol/version.ts"]);
  assert.deepEqual(hit("relay/src/agentHost/protocol.ts", ["export const AGENT_HOST_PROTOCOL_VERSION = 2;"]), ["relay/src/agentHost/protocol.ts"]);
  assert.deepEqual(hit("relay/src/agentHost/registry.ts", ["    const file: RegistryFile = { version: 2, agents };"]), ["relay/src/agentHost/registry.ts"]);
  assert.deepEqual(hit("relay/src/session/sessionStore.ts", ["  // migrate the legacy per-session record"]), ["relay/src/session/sessionStore.ts"]);
  assert.deepEqual(hit("infra/systemd/anywh-agent-host@.service.template"), ["infra/systemd/anywh-agent-host@.service.template"]);
  assert.deepEqual(hit("install.sh"), ["install.sh"]);
  assert.deepEqual(hit("infra/systemd/README.md"), []);
  assert.deepEqual(hit("client/src/lib/platform/hostBridge.ts"), ["client/src/lib/platform/hostBridge.ts"]);
  assert.deepEqual(hit("client/src-tauri/src/lib.rs", ["pub fn run_with("]), ["client/src-tauri/src/lib.rs"]);
  assert.deepEqual(hit("client/src-tauri/Cargo.toml", ['default = ["mobile-entry"]']), ["client/src-tauri/Cargo.toml"]);
  assert.deepEqual(hit("client/src-tauri/plugins/tauri-plugin-native-chrome/src/commands.rs"), [
    "client/src-tauri/plugins/tauri-plugin-native-chrome/src/commands.rs",
  ]);

  assert.deepEqual(hit("client/src-tauri/src/lib.rs", ["    let builder = builder.plugin(x);"]), []);
  assert.deepEqual(hit("relay/src/protocol/version.test.ts", ["export const WS_PROTOCOL_VERSION = 4;"]), []);
  assert.deepEqual(hit("relay/src/session/sessionStore.ts", ["  const title = session.title;"]), []);
  assert.deepEqual(hit("client/src/components/Thing.tsx", ["const a = 2;"]), []);
  assert.deepEqual(hit("docs/invariants.md", ["WS_PROTOCOL_VERSION = 4"]), []);
});

test("a touched surface passes only with `!` in the title or the not-breaking label", () => {
  const surfaces = [{ path: "install.sh", reason: "installer" }];
  assert.equal(guardVerdict({ surfaces, title: "fix(install): quote a path", labels: [] }).ok, false);
  assert.match(guardVerdict({ surfaces, title: "fix(install): quote a path", labels: [] }).message, /not-breaking/);
  assert.equal(guardVerdict({ surfaces, title: "fix(install)!: drop --mode", labels: [] }).ok, true);
  assert.equal(guardVerdict({ surfaces, title: "fix(install): quote a path", labels: ["not-breaking"] }).ok, true);
  assert.equal(guardVerdict({ surfaces: [], title: "fix: anything", labels: [] }).ok, true);
});

// The git-reading commands, against a real throwaway repository: a copy of
// the script inside it resolves that repository as its root.
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "version-repo-"));
  const run = (cmd, args, env = {}) =>
    execFileSync(cmd, args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
    });
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(here, "version.mjs"), join(dir, "scripts", "version.mjs"));
    run("git", ["init", "-q", "-b", "main"]);
    run("git", ["config", "commit.gpgsign", "false"]);
    run("git", ["config", "tag.gpgsign", "false"]);
    const commit = (message) => run("git", ["commit", "-q", "--allow-empty", "-m", message]);
    const tag = (name) => run("git", ["tag", "-a", name, "-m", name]);
    const version = (...args) => run("node", ["scripts/version.mjs", ...args]).trim();
    fn({ dir, run, commit, tag, version });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("plan: one tag per commit, each bumped by its own message", () => {
  const commits = [
    { sha: "b", messages: ["fix: scroll"] },
    { sha: "c", messages: ["feat(relay)!: protocol 4"] },
    { sha: "d", messages: ["feat: rooms"] },
  ];
  assert.deepEqual(planTags(commits, [0, 2, 0]), [
    { sha: "b", tag: "v0.2.1" },
    { sha: "c", tag: "v0.3.0" },
    { sha: "d", tag: "v0.3.1" },
  ]);
  assert.deepEqual(planTags([], [0, 2, 0]), []);
  // MAJOR replaces the head's own bump when the head is untagged...
  assert.deepEqual(planTags(commits, [0, 2, 0], { major: true, head: "d" }).at(-1), { sha: "d", tag: "v1.0.0" });
  assert.equal(planTags(commits, [0, 2, 0], { major: true, head: "d" }).length, 3);
  // ...and is an extra tag on a head that already has one.
  assert.deepEqual(planTags([], [0, 3, 1], { major: true, head: "d" }), [{ sha: "d", tag: "v1.0.0" }]);
});

test("merges from before the tool fold into the first one that has it", () => {
  const folded = foldUntooled([
    { sha: "a", message: "feat(relay): protocol 3", tooled: false },
    { sha: "b", message: "fix: scroll", tooled: false },
    { sha: "c", message: "feat!: version every merge", tooled: true },
    { sha: "d", message: "fix: typo", tooled: true },
  ]);
  assert.deepEqual(folded, [
    { sha: "c", messages: ["feat(relay): protocol 3", "fix: scroll", "feat!: version every merge"] },
    { sha: "d", messages: ["fix: typo"] },
  ]);
  assert.deepEqual(planTags(folded, [0, 1, 8]), [
    { sha: "c", tag: "v0.2.0" },
    { sha: "d", tag: "v0.2.1" },
  ]);
});

test("plan: tags every untagged merge since the last tag, so a run that never ran loses nothing", () => {
  withRepo(({ run, commit, tag, version }) => {
    commit("chore: initial");
    tag("v0.1.8");
    tag("v0.1.8-rc.1");
    commit("feat: rooms");
    assert.equal(version("plan"), "", "nothing from before the tool gets a tag of its own");
    run("git", ["add", "scripts/version.mjs"]);
    commit("feat!: version every merge");
    commit("fix: scroll");
    commit("feat: canvas");
    const plan = version("plan").split("\n").map((line) => line.split(" ")[1]);
    assert.deepEqual(plan, ["v0.2.0", "v0.2.1", "v0.2.2"]);
    tag("v0.2.2");
    assert.equal(version("plan"), "", "everything up to the newest tag counts as tagged");
    assert.match(version("plan", "--major"), /^[0-9a-f]{40} v1\.0\.0$/);
  });
});

test("notes: upgrade notes for crossed minors, then the changelog since the previous release", () => {
  withRepo(({ dir, commit, tag, version }) => {
    commit("chore: initial");
    tag("v0.1.8");
    commit("feat!: version every merge");
    tag("v0.2.0");
    commit("fix: scroll");
    tag("v0.2.1");

    assert.throws(() => version("notes", "--tag", "v0.2.1", "--previous", "v0.1.8", "--require-upgrade-notes"), /docs\/upgrade-notes\/0\.2\.md is missing/);

    mkdirSync(join(dir, "docs", "upgrade-notes"), { recursive: true });
    writeFileSync(join(dir, "docs", "upgrade-notes", "0.2.md"), "Update the relay and the app together.\n");
    const notes = version("notes", "--tag", "v0.2.1", "--previous", "v0.1.8", "--require-upgrade-notes");
    assert.equal(
      notes,
      [
        "## Upgrade notes\n\n### 0.2\n\nUpdate the relay and the app together.",
        "## Changes since v0.1.8\n\n### Breaking changes\n\n- feat!: version every merge (v0.2.0)\n\n### Fixes\n\n- fix: scroll (v0.2.1)",
      ].join("\n\n"),
    );

    // Within one minor line there is nothing to cross.
    assert.equal(version("notes", "--tag", "v0.2.1", "--previous", "v0.2.0", "--require-upgrade-notes"), "## Changes since v0.2.0\n\n### Fixes\n\n- fix: scroll (v0.2.1)");
  });
});

test("stamp writes every manifest or none, and check reads them back", () => {
  withRepo(({ dir, version }) => {
    const manifests = { "client/package.json": '{\n  "name": "client",\n  "version": "0.0.0"\n}\n', "client/src-tauri/tauri.conf.json": '{\n  "productName": "anywh",\n  "version": "0.0.0"\n}\n' };
    for (const [path, text] of Object.entries(manifests)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    mkdirSync(join(dir, "relay"));
    writeFileSync(join(dir, "relay", "package.json"), '{\n  "name": "anywh-relay"\n}\n');

    assert.throws(() => version("stamp", "0.2.0"), /relay\/package.json: no "version" field/);
    assert.equal(readFileSync(join(dir, "client", "package.json"), "utf8"), manifests["client/package.json"], "nothing written on a miss");

    writeFileSync(join(dir, "relay", "package.json"), '{\n  "name": "anywh-relay",\n  "version": "0.0.0"\n}\n');
    version("stamp", "0.2.0");
    assert.match(readFileSync(join(dir, "client", "src-tauri", "tauri.conf.json"), "utf8"), /"version": "0\.2\.0"/);
    assert.equal(version("check", "0.2.0"), "every manifest carries 0.2.0");
    assert.throws(() => version("check", "0.2.1"), /carries 0\.2\.0, expected 0\.2\.1/);
  });
});
