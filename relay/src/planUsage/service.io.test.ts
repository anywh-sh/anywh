import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanUsageCapture } from "./capture.js";
import { PlanUsageService, createFilePlanUsageStore, planUsagePathFor } from "./service.js";
import type { RuntimePlanUsage } from "./types.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "anywh-plan-usage-"));
}

const USAGE: RuntimePlanUsage = {
  runtime: "codex",
  status: "ok",
  windows: [{ durationMins: 43200, usedPercent: 37, resetsAt: 1795025523000, limitId: "codex" }],
  plan: { family: "free", label: "Free" },
  accountKey: "0123456789abcdef",
  observedAt: 1793320000000,
  source: "app_server_read",
  nextAutoRefreshAt: 1793320060000,
};

test("snapshot path sits beside the sessions file", () => {
  assert.equal(planUsagePathFor("/x/sessions.local.json"), "/x/sessions.local-plan-usage.json");
  assert.equal(planUsagePathFor("/x/sessions"), "/x/sessions-plan-usage.json");
});

test("the snapshot round-trips through a 0600 file, without what belongs to the process", () => {
  const path = join(dir(), "nested", "s-plan-usage.json");
  const store = createFilePlanUsageStore(path);
  assert.equal(store.load(), undefined);
  store.save([USAGE, { runtime: "claude", status: "error", windows: [], observedAt: null, error: { kind: "network" } }]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const { nextAutoRefreshAt: _dropped, ...expected } = USAGE;
  assert.deepEqual(store.load(), [expected, { runtime: "claude", status: "unknown", windows: [], observedAt: null }]);
});

test("a corrupt or foreign file loads as nothing; bad entries and windows are dropped", () => {
  const path = join(dir(), "p.json");
  writeFileSync(path, "{not json");
  assert.equal(createFilePlanUsageStore(path).load(), undefined);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      runtimes: [{ runtime: "gemini", status: "ok", windows: [], observedAt: null }, { ...USAGE, windows: [{ durationMins: "300" }, ...USAGE.windows], email: "a@example.invalid" }],
    }),
  );
  const loaded = createFilePlanUsageStore(path).load();
  assert.equal(loaded?.length, 1);
  assert.equal(loaded?.[0]?.windows.length, 1);
  assert.ok(!JSON.stringify(loaded).includes("example.invalid"));
});

test("what the service persists carries no e-mail, UUID or tier string", async () => {
  const path = join(dir(), "s-plan-usage.json");
  const service = new PlanUsageService({
    now: () => 1793320000000,
    setInterval: () => 0,
    clearInterval: () => {},
    capture: new PlanUsageCapture(() => 1793320000000),
    probeEnabled: true,
    probeClaude: () =>
      Promise.resolve({
        kind: "reading",
        reading: { status: "ok", windows: [{ durationMins: 300, usedPercent: 12, resetsAt: 1793330000000 }], observedAt: 1793320000000, source: "probe" },
        claudeStatus: "allowed",
        auth: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "a@example.invalid", orgId: "org-uuid-1" },
      }),
    readClaudeAuth: () => Promise.resolve({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "a@example.invalid", orgId: "org-uuid-1" }),
    readClaudeAccountFile: () =>
      Promise.resolve({
        tiers: { userRateLimitTier: null, organizationRateLimitTier: "default_claude_max_20x", seatTier: null, organizationType: null },
        identity: { accountUuid: "acc-uuid-1", organizationUuid: "org-uuid-1" },
      }),
    hasClaudeActivitySince: () => Promise.resolve(false),
    readClaudeTranscriptLimit: () => Promise.resolve(undefined),
    createCodexReader: () => ({ read: () => Promise.resolve({ kind: "auth", status: "signed_out" }), close: () => {} }),
    loadSalt: () => Promise.resolve(new Uint8Array(32)),
    store: createFilePlanUsageStore(path),
  });
  service.setInstalledRuntimes(["claude"]);
  await service.refresh({ force: true });
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("Max 20x"));
  for (const leaked of ["example.invalid", "uuid", "default_claude"]) assert.ok(!text.includes(leaked), leaked);
});
