import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./sessionManager.js";
import { SessionStore } from "./sessionStore.js";
import { claudeRuntimeDef } from "../runtimes/defs/claude/index.js";
import { buildRegistry } from "../runtimes/registry.js";
import type { Registry } from "../runtimes/registry.js";

// `.io.test.ts`, not the pure tier: `lastActiveAtOf` only has one real
// dependency (the store's own persisted timestamp), but a real SessionStore
// is backed by a real file, so this test uses a real tmpdir the same way
// sessionStore.test.ts already does — no new mock, per the boundary tier's
// own rule.
//
// `claudeRuntimeDef` only, never `codexRuntimeDef`, in this file — `session/`
// may only import a def through its own `index.ts` barrel
// (`import-x/no-restricted-paths`, eslint.config.js), and `runtimes/defs/codex.ts`
// has no barrel (flat file, unlike `defs/claude/`). `spyRegistry` below
// works around this the same way production code does: `SessionManager`
// itself never needs to name a second def, only call `registry.get`.
function makeManager(): { manager: SessionManager; store: SessionStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-test-"));
  const store = new SessionStore(join(dir, "sessions.json"), "/home/user");
  const manager = new SessionManager(undefined, store, buildRegistry([claudeRuntimeDef]));
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

// SessionStore has no writer for a non-default agentId yet (nothing picks
// one in production — SELECTABLE_AGENT_IDS in server.ts still lists only
// "claude"), so this seeds the file directly, the same technique
// sessionStore.test.ts already uses for its pre-migration-shape tests.
function seedSessionsFile(dir: string, id: string, agentId: string): string {
  const filePath = join(dir, "sessions.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      [id]: {
        agentId,
        sessionId: {},
        title: "Seeded session",
        cwd: { cwd: "/home/user", locked: false },
        lastActiveAt: Date.now(),
      },
    }),
  );
  return filePath;
}

// A plain object satisfying `Registry` structurally, its `get` a spy —
// deliberately NOT `buildRegistry([...])` here. Every def constructs a
// working driver no matter which agentId it's handed (nothing validates
// "does this def match the agentId that was persisted"), so
// `assert.doesNotThrow` around `new SessionManager(...)` can't tell
// "createSession resolved via the registry" apart from "it kept ignoring
// the registry and always used the claudeRuntimeDef literal" — the exact
// regression this commit exists to fix. Spying on `get` itself is the only
// way to observe which id `createSession` actually asked the registry for.
function spyRegistry(): { registry: Registry; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    registry: {
      defs: [claudeRuntimeDef],
      get: (id) => {
        calls.push(id);
        return claudeRuntimeDef;
      },
    },
  };
}

test("createSession resolves a persisted agentId by calling registry.get(agentId), not a hardcoded literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-test-"));
  try {
    const filePath = seedSessionsFile(dir, "s-codex", "codex");
    const store = new SessionStore(filePath, "/home/user");
    const { registry, calls } = spyRegistry();
    // The constructor's own boot loop (sessionStore.listIds()) is what
    // exercises this — no explicit getOrCreate call needed, since a relay
    // restart must reconstruct every persisted session, live tab or not.
    new SessionManager(undefined, store, registry);
    assert.deepEqual(calls, ["codex"], "registry.get must be called with the session's own persisted agentId");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSession falls back to claudeRuntimeDef, without throwing, when registry.get(agentId) returns undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-test-"));
  try {
    const filePath = seedSessionsFile(dir, "s-unknown", "some-future-agent-this-build-does-not-ship");
    const store = new SessionStore(filePath, "/home/user");
    const calls: string[] = [];
    // Unlike spyRegistry() above, this registry genuinely has nothing for
    // any id — the case `createSession`'s own `?? claudeRuntimeDef` exists
    // to degrade honestly instead of SharedSession's constructor throwing
    // on an undefined def.
    const emptyRegistry: Registry = {
      defs: [],
      get: (id) => {
        calls.push(id);
        return undefined;
      },
    };
    assert.doesNotThrow(() => new SessionManager(undefined, store, emptyRegistry));
    assert.deepEqual(calls, ["some-future-agent-this-build-does-not-ship"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live list update of a room's principal is marked as a room; an ordinary session's is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-room-test-"));
  try {
    const store = new SessionStore(join(dir, "sessions.json"), "/home/user");
    const events: unknown[] = [];
    const manager = new SessionManager(undefined, store, buildRegistry([claudeRuntimeDef]), undefined, undefined, undefined, undefined, undefined, undefined, (event) => events.push(event));
    store.setTitle("plain", "Plain");
    store.setTitle("p1", "Room");
    store.setRoom("p1", { roomId: "p1", role: "principal", createdBy: "user", task: "", undeliveredReports: [] });
    manager.renameTitle("plain", "Plain renamed");
    manager.renameTitle("p1", "Room renamed");
    assert.deepEqual(
      events.map((e) => ({ id: (e as { id: string }).id, room: (e as { room?: true }).room })),
      [
        { id: "plain", room: undefined },
        { id: "p1", room: true },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A room agent is titled with its task's first line until a short title is
// generated; clients draw a placeholder for exactly that wait, so the list
// must say when it starts and when it ends, however it ends.
function titleStack(generator: (text: string) => Promise<string | null>, maxMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionmanager-title-test-"));
  const store = new SessionStore(join(dir, "sessions.json"), "/home/user");
  const events: { id: string; title: string; room?: true; titlePending?: true }[] = [];
  const manager = new SessionManager(
    undefined,
    store,
    buildRegistry([claudeRuntimeDef]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => {
      if (event.type === "upsert") events.push(event);
    },
    undefined,
    undefined,
    undefined,
    { titleGenerator: (_def, _home, _cwd, text) => generator(text), ...(maxMs === undefined ? {} : { titlePendingMaxMs: maxMs }) },
  );
  store.setTitle("p1", "Fix the whole login flow, again");
  store.setRoom("p1", { roomId: "p1", role: "principal", createdBy: "user", task: "", undeliveredReports: [] });
  return { manager, store, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a generated title ends the wait: pending from the call to the title, and the list is told both times", async () => {
  let finish: (title: string | null) => void = () => undefined;
  const { manager, store, events, cleanup } = titleStack(() => new Promise((resolve) => (finish = resolve)));
  try {
    manager.generateTitle("p1", "Fix the whole login flow, again");
    assert.equal(store.isTitlePending("p1"), true);
    assert.equal(manager.listTitled().find((s) => s.id === "p1")?.titlePending, true);
    assert.equal(events.at(-1)?.title, "Fix the whole login flow, again");
    assert.equal(events.at(-1)?.titlePending, true);
    assert.equal(events.at(-1)?.room, true);
    finish("Login flow");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.isTitlePending("p1"), false);
    assert.equal(store.getTitle("p1"), "Login flow");
    assert.equal(events.at(-1)?.title, "Login flow");
    assert.equal(events.at(-1)?.titlePending, undefined);
    assert.equal(manager.listTitled().find((s) => s.id === "p1")?.titlePending, undefined);
  } finally {
    cleanup();
  }
});

test("a failed generation ends the wait and keeps the provisional title", async () => {
  const { manager, store, events, cleanup } = titleStack(() => Promise.reject(new Error("no CLI")));
  const log = console.error;
  console.error = () => undefined;
  try {
    manager.generateTitle("p1", "Fix the whole login flow, again");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.isTitlePending("p1"), false);
    assert.equal(store.getTitle("p1"), "Fix the whole login flow, again");
    assert.equal(events.at(-1)?.titlePending, undefined);
  } finally {
    console.error = log;
    cleanup();
  }
});

test("a generation that never answers stops being awaited after the limit, and a late title still lands", async () => {
  let finish: (title: string | null) => void = () => undefined;
  const { manager, store, events, cleanup } = titleStack(() => new Promise((resolve) => (finish = resolve)), 20);
  try {
    manager.generateTitle("p1", "Fix the whole login flow, again");
    assert.equal(store.isTitlePending("p1"), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(store.isTitlePending("p1"), false);
    assert.equal(events.at(-1)?.titlePending, undefined);
    assert.equal(store.getTitle("p1"), "Fix the whole login flow, again");
    finish("Login flow");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.getTitle("p1"), "Login flow");
  } finally {
    cleanup();
  }
});

test("a rename by hand ends the wait at once", () => {
  const { manager, store, events, cleanup } = titleStack(() => new Promise(() => undefined));
  try {
    manager.generateTitle("p1", "Fix the whole login flow, again");
    manager.renameTitle("p1", "By hand");
    assert.equal(store.isTitlePending("p1"), false);
    assert.equal(events.at(-1)?.title, "By hand");
    assert.equal(events.at(-1)?.titlePending, undefined);
  } finally {
    cleanup();
  }
});
