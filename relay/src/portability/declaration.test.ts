import { test } from "node:test";
import assert from "node:assert/strict";
import { listDeclaredServers, mergeDeclaration, parseDeclaration, pickPortableKeys } from "./declaration.js";

// Verbatim shape of a real ~/.codex/config.toml (codex-cli 0.154.0): two
// portable scalars and one per-project trust entry keyed by an absolute
// path from the machine that wrote it.
const REAL_CODEX_CONFIG = `model = "gpt-5.6-terra"
model_reasoning_effort = "medium"
[projects."/home/wil/anywh"]
trust_level = "trusted"
`;

const CODEX_PORTABLE_KEYS = ["model", "model_reasoning_effort", "mcp_servers"];

test("pickPortableKeys: the allowlist decides, so a per-project trust entry never travels", () => {
  const picked = pickPortableKeys(parseDeclaration(REAL_CODEX_CONFIG, "toml"), CODEX_PORTABLE_KEYS);
  assert.deepEqual(picked, { model: "gpt-5.6-terra", model_reasoning_effort: "medium" });
  assert.ok(!Object.hasOwn(picked, "projects"), "trusting a path this machine has never seen is not portable");
});

test("pickPortableKeys: a key the source doesn't have stays absent, not undefined", () => {
  const picked = pickPortableKeys({ model: "x" }, CODEX_PORTABLE_KEYS);
  // `{mcp_servers: undefined}` would be dropped by JSON and rejected
  // outright by a TOML serializer.
  assert.deepEqual(Object.keys(picked), ["model"]);
});

test("mergeDeclaration: TOML — carried keys land, the destination's own keys survive", () => {
  const destination = `model = "gpt-5.1"
[projects."/srv/other"]
trust_level = "trusted"
`;
  const merged = mergeDeclaration(destination, { model: "gpt-5.6-terra", mcp_servers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } }, "toml");
  const parsed = parseDeclaration(merged, "toml");
  assert.equal(parsed.model, "gpt-5.6-terra", "a carried key replaces the destination's");
  assert.deepEqual(parsed.mcp_servers, { sentry: { url: "https://mcp.sentry.dev/mcp" } });
  assert.deepEqual(parsed.projects, { "/srv/other": { trust_level: "trusted" } }, "the destination's own trust entry is untouched");
});

test("mergeDeclaration: a server table replaces wholesale rather than deep-merging", () => {
  // Half of the destination's server and half of the source's would be a
  // configuration neither machine ever had.
  const destination = '[mcp_servers.sentry]\nurl = "https://old.example/mcp"\nbearer_token_env_var = "OLD"\n';
  const merged = mergeDeclaration(destination, { mcp_servers: { sentry: { url: "https://new.example/mcp" } } }, "toml");
  assert.deepEqual(parseDeclaration(merged, "toml").mcp_servers, { sentry: { url: "https://new.example/mcp" } });
});

test("mergeDeclaration: JSON — one key merged into a file full of machine state", () => {
  // The shape that matters for Claude: `.claude.json` is 100 KB of
  // machine identity and local project paths, and exactly one key of it
  // is portable.
  const destination = JSON.stringify({ machineID: "abc", userID: "def", projects: { "/home/someone/x": { history: [] } } });
  const merged = mergeDeclaration(destination, { mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }, "json");
  const parsed = parseDeclaration(merged, "json");
  assert.equal(parsed.machineID, "abc", "the destination's own machine identity stays its own");
  assert.deepEqual(parsed.projects, { "/home/someone/x": { history: [] } });
  assert.deepEqual(parsed.mcpServers, { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } });
});

test("mergeDeclaration: an empty destination is the common case — a fresh home", () => {
  const merged = mergeDeclaration("", { mcp_servers: { sentry: { url: "https://x" } } }, "toml");
  assert.deepEqual(parseDeclaration(merged, "toml"), { mcp_servers: { sentry: { url: "https://x" } } });
});

test("mergeDeclaration: a destination that doesn't parse is replaced, not appended to", () => {
  // Appending to a file the CLI can't read would leave it unreadable and
  // blame the feature that touched it last.
  const merged = mergeDeclaration("this is not valid toml at all ][", { model: "x" }, "toml");
  assert.deepEqual(parseDeclaration(merged, "toml"), { model: "x" });
});

test("parseDeclaration: a missing or non-object file reads as nothing to carry", () => {
  assert.deepEqual(parseDeclaration("", "json"), {});
  assert.deepEqual(parseDeclaration("[1,2,3]", "json"), {});
  assert.deepEqual(parseDeclaration("null", "json"), {});
  assert.deepEqual(parseDeclaration("{{{", "json"), {});
  assert.deepEqual(parseDeclaration("= not toml", "toml"), {});
});

test("listDeclaredServers: names under the def's own key, in both spellings", () => {
  assert.deepEqual(listDeclaredServers({ mcp_servers: { sentry: {}, linear: {} } }, "mcp_servers"), ["sentry", "linear"]);
  assert.deepEqual(listDeclaredServers({ mcpServers: { sentry: {} } }, "mcpServers"), ["sentry"]);
  // The other CLI's spelling is not consulted — the def names one key.
  assert.deepEqual(listDeclaredServers({ mcpServers: { sentry: {} } }, "mcp_servers"), []);
  assert.deepEqual(listDeclaredServers({ mcp_servers: ["sentry"] }, "mcp_servers"), []);
});
