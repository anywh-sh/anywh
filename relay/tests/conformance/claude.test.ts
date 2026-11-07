// Conformance (opt-in, never in CI): the REAL `claude` against local fake
// OAuth/MCP servers, in a throwaway $HOME, driven by the relay's own code
// (auth/claude.ts, claudeControl.ts) — the undocumented control requests
// the def records (`mcp_status`, `mcp_authenticate`, `mcp_oauth_callback_url`,
// `mcp_reconnect`, `mcp_call`) still answering in the shapes the fakes of
// the CI tiers reproduce, and `mcp add-json` (the def's `mcp.add`) declaring
// a server the next process loads. No turn is run: no model call, no account login.
// A failed call's text (the def's `failureClassifier`) only shows in a
// turn's `tool_result`, so it is not checked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeRuntimeDef } from "../../src/runtimes/defs/claude/index.js";
import { declareMcpServer } from "../../src/integrations/add.js";
import { ClaudeAuthDriver, statusIn } from "../../src/integrations/auth/claude.js";
import { claudeControlArgs, startClaudeControl } from "../../src/integrations/claudeControl.js";
import type { McpInventoryEntry } from "../../src/integrations/types.js";
import { consent, startFakeOAuthMcp } from "../fixtures/fake-oauth-mcp.mjs";
import { conformanceSkip, installedVersion, throwawayHome } from "./helpers.js";

const entry = (name: string, url: string): McpInventoryEntry => ({ runtimeId: "claude", name, scope: "user", transport: { type: "http", url }, status: "needs_auth", authMode: "oauth", scannedAt: 0 });

test("Claude signs in through the app's link and through loopback, and calls a tool with no turn", { skip: conformanceSkip, timeout: 180_000 }, async (t) => {
  t.diagnostic(`claude ${installedVersion("claude")}; recorded with ${claudeRuntimeDef.portability.mcp.kind === "supported" && claudeRuntimeDef.portability.mcp.auth?.recordedWith}`);
  const lenient = await startFakeOAuthMcp();
  const strict = await startFakeOAuthMcp({ rejectCustomRedirect: true });
  const { home, cleanup } = throwawayHome("claude");
  const args = claudeControlArgs(claudeRuntimeDef);
  assert.ok(args);
  try {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { fake: { type: "http", url: lenient.url }, strict: { type: "http", url: strict.url } } }),
    );
    const status = async (name: string) => {
      const control = startClaudeControl({ def: claudeRuntimeDef, args, cwd: home, homeOverride: home });
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          const current = statusIn(await control.request("mcp_status"), name);
          if (current !== "pending") return current;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return "pending";
      } finally {
        control.close();
      }
    };
    assert.equal(await status("fake"), "needs_auth");
    const driver = new ClaudeAuthDriver({ def: claudeRuntimeDef, homeOverride: home, neutralCwd: home });

    // The app's link, registered with the server and given back.
    const deeplink = await driver.begin(entry("fake", lenient.url), "deeplink");
    try {
      assert.equal(deeplink.mode, "deeplink");
      assert.equal(new URL(deeplink.authUrl).searchParams.get("redirect_uri"), "anywh://mcp-oauth/callback");
      const location = await consent(deeplink.authUrl);
      assert.match(location, /^anywh:\/\/mcp-oauth\/callback\?code=/);
      assert.equal(new URL(location).searchParams.get("state"), deeplink.state);
      await deeplink.complete?.(location);
    } finally {
      deeplink.close();
    }
    assert.equal(await status("fake"), "connected", "a new process has the token");

    // A tool called by the relay itself, no turn.
    const control = startClaudeControl({ def: claudeRuntimeDef, args, cwd: home, homeOverride: home });
    try {
      for (let attempt = 0; attempt < 20 && statusIn(await control.request("mcp_status"), "fake") === "pending"; attempt++) await new Promise((resolve) => setTimeout(resolve, 500));
      const result = (await control.request("mcp_call", { tool: "mcp__fake__ping", arguments: {} })) as { content?: { text?: string }[] };
      assert.equal(result.content?.[0]?.text, "pong");
    } finally {
      control.close();
    }

    // A server that refuses the app's link: the CLI falls back to loopback
    // by itself, and the address the browser ended on completes it.
    const loopback = await driver.begin(entry("strict", strict.url), "deeplink");
    try {
      assert.equal(loopback.mode, "localhost");
      const location = await consent(loopback.authUrl);
      assert.match(location, /^http:\/\/localhost:\d+\/callback\?code=/);
      await loopback.complete?.(location);
    } finally {
      loopback.close();
    }
    assert.equal(await status("strict"), "connected");
    assert.ok(strict.registrations.some((uris) => uris.some((uri) => uri.startsWith("anywh://"))), "the app's link was tried first");

    // A server declared through the CLI, as "+ Add" does: in the user's
    // config, and loaded (signed out) by the next process.
    const { mcp } = claudeRuntimeDef.portability;
    assert.ok(mcp.kind === "supported" && mcp.add);
    await declareMcpServer({ homeOverride: home, neutralCwd: home }, claudeRuntimeDef, mcp.add, "added", { type: "http", url: lenient.url });
    const declared = (JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, { url?: string }> }).mcpServers?.added;
    assert.equal(declared?.url, lenient.url);
    assert.equal(await status("added"), "needs_auth");
  } finally {
    await cleanup();
    await lenient.close();
    await strict.close();
  }
});
