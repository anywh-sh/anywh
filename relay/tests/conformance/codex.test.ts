// Conformance (opt-in, never in CI): the REAL `codex app-server` against
// local fake OAuth/MCP servers, in a throwaway $HOME (so its CODEX_HOME),
// driven by the relay's own code (auth/codex.ts, codexControl.ts): the
// per-process `-c …oauth.callback_url/callback_port` override, the app's
// link registered and the callback delivered to the CLI's listener, the
// loopback fallback, a tool called with no turn, how a failed call is
// worded (the def's `failureClassifier`), and `config/value/write` (the
// def's `mcp.add`) declaring a server the daemon loads. No turn, no account
// login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexRuntimeDef } from "../../src/runtimes/defs/codex.js";
import { declareMcpServer } from "../../src/integrations/add.js";
import { CodexAuthDriver } from "../../src/integrations/auth/codex.js";
import { parseCodexMcpServerStatusList } from "../../src/integrations/inventory/codex.js";
import { createCodexControl } from "../../src/integrations/codexControl.js";
import { classifyMcpFailure } from "../../src/runtimes/mcpFailure.js";
import type { McpFailureClassifier } from "../../src/runtimes/types.js";
import type { McpInventoryEntry } from "../../src/integrations/types.js";
import { consent, startFakeOAuthMcp } from "../fixtures/fake-oauth-mcp.mjs";
import { startFakeMcp } from "../fixtures/fake-mcp.mjs";
import { conformanceSkip, installedVersion, throwawayHome } from "./helpers.js";

const FAKE_MCP = resolve(import.meta.dirname, "../fixtures/fake-mcp.mjs");
const entry = (name: string, url: string): McpInventoryEntry => ({ runtimeId: "codex", name, scope: "user", transport: { type: "http", url }, status: "needs_auth", authMode: "oauth", scannedAt: 0 });
const mcp = codexRuntimeDef.portability.mcp;
const classifier = (mcp.kind === "supported" ? mcp.failureClassifier : undefined) as McpFailureClassifier;
const textOf = (result: unknown): string => ((result as { content?: { text?: string }[] }).content ?? []).map((part) => part.text ?? "").join("\n");

test("Codex signs in through the app's link and through loopback, calls a tool with no turn, and words failures as recorded", { skip: conformanceSkip, timeout: 180_000 }, async (t) => {
  t.diagnostic(`codex ${installedVersion("codex")}; recorded with ${mcp.kind === "supported" && mcp.auth?.recordedWith}`);
  const lenient = await startFakeOAuthMcp();
  const strict = await startFakeOAuthMcp({ rejectCustomRedirect: true });
  const expiring = await startFakeMcp("expire-on-call");
  const { home, cleanup } = throwawayHome("codex");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      "check_for_update_on_startup = false",
      "[mcp_servers.fake]",
      `url = "${lenient.url}"`,
      "[mcp_servers.strict]",
      `url = "${strict.url}"`,
      "[mcp_servers.expiring]",
      `url = "${expiring.url}"`,
      "[mcp_servers.crashy]",
      `command = "${process.execPath}"`,
      `args = ["${FAKE_MCP}", "stdio"]`,
      "",
    ].join("\n"),
  );
  const control = createCodexControl({ def: codexRuntimeDef, homeOverride: home, cwd: home, requestTimeoutMs: 30_000 });
  try {
    const driver = new CodexAuthDriver({ def: codexRuntimeDef, homeOverride: home, cwd: home });

    const deeplink = await driver.begin(entry("fake", lenient.url), "deeplink");
    try {
      assert.equal(deeplink.mode, "deeplink");
      assert.match(new URL(deeplink.authUrl).searchParams.get("redirect_uri") ?? "", /^anywh:\/\/mcp-oauth\/callback\/[\w-]+$/, "the per-process override took");
      const location = await consent(deeplink.authUrl);
      assert.match(location, /^anywh:\/\/mcp-oauth\/callback\/[\w-]+\?code=/);
      await deeplink.complete?.(location);
    } finally {
      deeplink.close();
    }
    assert.equal(textOf(await control.callTool("fake", "ping", {})), "pong", "a daemon started after the sign-in has the token");

    const loopback = await driver.begin(entry("strict", strict.url), "deeplink");
    try {
      assert.equal(loopback.mode, "localhost", "invalid_redirect_uri falls back to loopback");
      const location = await consent(loopback.authUrl);
      assert.match(location, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[\w-]+\?code=/);
      await loopback.complete?.(location);
    } finally {
      loopback.close();
    }
    await control.reload();
    assert.equal(textOf(await control.callTool("strict", "ping", {})), "pong", "a running daemon loads it after a reload");

    // A 401 on the call: a result whose `_meta` asks for a sign-in.
    const expired = (await control.callTool("expiring", "ping", {})) as { isError?: boolean; _meta?: unknown };
    assert.equal(expired.isError, true);
    assert.equal(classifyMcpFailure(classifier, { text: textOf(expired), meta: expired._meta }), "auth");
    // A server that dies mid-call.
    const crash = await control.callTool("crashy", "crash", {}).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    t.diagnostic(`crash: ${crash}`);
    assert.equal(classifyMcpFailure(classifier, { text: crash }), "crashed");

    // A server declared through the app-server, as "+ Add" does: in the
    // config file, and listed (signed out) by the daemon after a reload.
    assert.ok(mcp.kind === "supported" && mcp.add);
    await declareMcpServer({ homeOverride: home, neutralCwd: home, codexRequest: (method, params) => control.request(method, params) }, codexRuntimeDef, mcp.add, "added", { url: lenient.url });
    assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.added\][^[]*url = "http:\/\/127\.0\.0\.1:\d+/);
    await control.reload();
    const listed = parseCodexMcpServerStatusList(await control.request("mcpServerStatus/list", {}));
    t.diagnostic(`added: ${JSON.stringify(listed?.servers.find((server) => server.name === "added"))}`);
    assert.equal(listed?.servers.find((server) => server.name === "added")?.status, "needs_auth");
  } finally {
    control.close();
    await cleanup();
    await lenient.close();
    await strict.close();
    await expiring.close();
  }
});
