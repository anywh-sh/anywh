import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./sessionManager.js";
import { SessionStore } from "./sessionStore.js";

// `.io.test.ts`, not the pure tier: `lastActiveAtOf` only has one real
// dependency (the store's own persisted timestamp), but a real SessionStore
// is backed by a real file, so this test uses a real tmpdir the same way
// sessionStore.test.ts already does — no new mock, per the boundary tier's
// own rule.
function makeManager(): { manager: SessionManager; store: SessionStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-test-"));
  const store = new SessionStore(join(dir, "sessions.json"), "/home/user");
  const manager = new SessionManager(undefined, store);
  return { manager, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lastActiveAtOf: an id the store has never seen falls back to roughly now", () => {
  const { manager, cleanup } = makeManager();
  try {
    const before = Date.now();
    const value = manager.lastActiveAtOf("never-recorded");
    const after = Date.now();
    assert.ok(value >= before && value <= after, "the fallback is Date.now(), not some stale default");
  } finally {
    cleanup();
  }
});

// The regression this file's own comment on `lastActiveAtOf` explicitly
// guards: reading from the store rather than taking Date.now(), because a
// manual rename doesn't touch lastActiveAt, and reporting "now" for it
// would resurrect a years-old session under "today" the moment it's renamed.
test("lastActiveAtOf: a recorded id keeps returning its stored timestamp, not the time of the call", async () => {
  const { manager, store, cleanup } = makeManager();
  try {
    store.recordId("s1");
    const recordedAt = store.getLastActiveAt("s1");
    assert.ok(recordedAt !== undefined);

    // A real gap so a second `Date.now()` call is provably later than the
    // one `recordId` captured — the point being tested is that the second
    // read does NOT pick up this later time.
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(manager.lastActiveAtOf("s1"), recordedAt);
    assert.notEqual(manager.lastActiveAtOf("s1"), Date.now());
  } finally {
    cleanup();
  }
});
