import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./sessionStore.js";

const DEFAULT_CWD = "/home/user";

function withStoreFile(seed: unknown, run: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionstore-test-"));
  const filePath = join(dir, "sessions.json");
  try {
    if (seed !== undefined) writeFileSync(filePath, JSON.stringify(seed));
    run(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("missing file: starts empty, recordId seeds an unlocked default cwd and no title", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.deepEqual(store.listIds(), []);
    assert.deepEqual(store.listTitled(), []);
    store.recordId("abc-123");
    assert.deepEqual(store.getCwdState("abc-123"), { cwd: DEFAULT_CWD, locked: false });
    assert.equal(store.getSessionId("abc-123"), undefined);
    assert.equal(store.getTitle("abc-123"), null);
    assert.deepEqual(store.listTitled(), []);
  });
});

test("setTitle records the title and the session starts showing up in listTitled", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("abc-123");
    store.setTitle("abc-123", "Fix the save button bug");
    assert.equal(store.getTitle("abc-123"), "Fix the save button bug");
    const listed = store.listTitled();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "abc-123");
    assert.equal(listed[0].title, "Fix the save button bug");
    // On the wire since the sidebar groups by recency — a row without it
    // would leave the client with nothing to bucket the session under.
    assert.equal(typeof listed[0].lastActiveAt, "number");
  });
});

test("clearTitle (/clear) drops the title and the session leaves listTitled again", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("abc-123");
    store.setTitle("abc-123", "Fix the save button bug");
    store.clearTitle("abc-123");
    assert.equal(store.getTitle("abc-123"), null);
    assert.deepEqual(store.listTitled(), []);
  });
});

test("migration: legacy shape (name -> session_id|null) becomes the new shape with title = old name", () => {
  withStoreFile({ "com-historico": "abc-123", "sem-turno-ainda": null }, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);

    // Session that already had a real session_id: locks (doesn't risk its --resume).
    assert.deepEqual(store.getCwdState("com-historico"), { cwd: DEFAULT_CWD, locked: true });
    assert.equal(store.getSessionId("com-historico"), "abc-123");
    assert.equal(store.getTitle("com-historico"), "com-historico");

    // Session with no session_id yet: unlocked, but already titled with its own name.
    assert.deepEqual(store.getCwdState("sem-turno-ainda"), { cwd: DEFAULT_CWD, locked: false });
    assert.equal(store.getSessionId("sem-turno-ainda"), undefined);
    assert.equal(store.getTitle("sem-turno-ainda"), "sem-turno-ainda");

    // Re-persisted in the new shape — reopening doesn't re-detect it as legacy.
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    const { lastActiveAt, ...rest } = persisted["com-historico"];
    assert.equal(typeof lastActiveAt, "number");
    assert.deepEqual(rest, {
      sessionId: "abc-123",
      title: "com-historico",
      cwd: { cwd: DEFAULT_CWD, locked: true },
    });
  });
});

test("migration: pre-title shape (no title field) gets title = id", () => {
  withStoreFile(
    { s1: { sessionId: "sess-1", cwd: { cwd: "/tmp/projeto", locked: true } } },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      assert.equal(store.getTitle("s1"), "s1");
      assert.equal(store.getSessionId("s1"), "sess-1");
      assert.deepEqual(store.getCwdState("s1"), { cwd: "/tmp/projeto", locked: true });
    },
  );
});

test("migration: pre-activity shape (with title, no lastActiveAt) gets lastActiveAt", () => {
  withStoreFile(
    { s1: { sessionId: "sess-1", title: "Session 1", cwd: { cwd: "/tmp/projeto", locked: true } } },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      const listed = store.listTitled();
      assert.deepEqual(
        listed.map(({ id, title }) => ({ id, title })),
        [{ id: "s1", title: "Session 1" }],
      );
      const persisted = JSON.parse(readFileSync(filePath, "utf8"));
      assert.equal(typeof persisted.s1.lastActiveAt, "number");
      // The migrated record's seeded timestamp is what `listTitled` hands
      // out, not a second `Date.now()` computed at read time.
      assert.equal(listed[0].lastActiveAt, persisted.s1.lastActiveAt);
    },
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("listTitled sorts by lastActiveAt descending (most recent first)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-sessionstore-test-"));
  try {
    const filePath = join(dir, "sessions.json");
    const store = new SessionStore(filePath, DEFAULT_CWD);

    // `setTimeout` between each operation: `Date.now()` has 1ms resolution,
    // consecutive synchronous calls almost always tie on the same
    // millisecond — without the delay, the test would depend on luck.
    store.recordId("s1");
    store.setTitle("s1", "First");
    await sleep(5);
    store.recordId("s2");
    store.setTitle("s2", "Second");
    await sleep(5);
    store.recordId("s3");
    store.setTitle("s3", "Third");

    // Without touching anything, the order follows creation (most recent first).
    assert.deepEqual(
      store.listTitled().map((s) => s.id),
      ["s3", "s2", "s1"],
    );

    // Reopening the oldest (s1) moves it to the top.
    await sleep(5);
    store.touch("s1");
    assert.deepEqual(
      store.listTitled().map((s) => s.id),
      ["s1", "s3", "s2"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteEntry removes the session and returns false if it no longer existed", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setTitle("s1", "Session 1");
    assert.equal(store.deleteEntry("s1"), true);
    assert.deepEqual(store.listTitled(), []);
    assert.equal(store.getTitle("s1"), null);
    assert.equal(store.deleteEntry("s1"), false);

    // Reopening the file reflects the removal.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.deepEqual(reopened.listIds(), []);
  });
});

test("setCwd/lockCwd/getCwdState round-trip and persist to disk", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setCwd("s1", "/home/user/projects/demo");
    assert.deepEqual(store.getCwdState("s1"), { cwd: "/home/user/projects/demo", locked: false });

    store.lockCwd("s1");
    assert.deepEqual(store.getCwdState("s1"), { cwd: "/home/user/projects/demo", locked: true });

    // Reopening the file reflects what was persisted.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.deepEqual(reopened.getCwdState("s1"), { cwd: "/home/user/projects/demo", locked: true });
  });
});

test("recordSessionId records the id without touching the already-chosen cwd", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setCwd("s1", "/tmp/projeto");
    store.recordSessionId("s1", "sess-1");
    assert.equal(store.getSessionId("s1"), "sess-1");
    assert.deepEqual(store.getCwdState("s1"), { cwd: "/tmp/projeto", locked: false });
  });
});

test("getContextUsage with no record yet: undefined, doesn't break (new session, no turn has run)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(store.getContextUsage("nunca-visto"), undefined);
  });
});

test("setContextUsage round-trips and persists to disk, surviving reopening the file", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setContextUsage("s1", { model: "claude-sonnet-5", contextWindowSize: 1_000_000, usedTokens: 30693 });
    assert.deepEqual(store.getContextUsage("s1"), {
      model: "claude-sonnet-5",
      contextWindowSize: 1_000_000,
      usedTokens: 30693,
    });

    // Simulates a relay restart: the value survives without waiting for a new turn.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.deepEqual(reopened.getContextUsage("s1"), {
      model: "claude-sonnet-5",
      contextWindowSize: 1_000_000,
      usedTokens: 30693,
    });
  });
});

test("setContextUsage called before recordId still works (ensureEntry creates the record)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.setContextUsage("nova", { model: "claude-opus-5", contextWindowSize: 200_000, usedTokens: 1000 });
    assert.deepEqual(store.getContextUsage("nova"), {
      model: "claude-opus-5",
      contextWindowSize: 200_000,
      usedTokens: 1000,
    });
  });
});

test("old record without contextUsage (written before this feature existed) loads normally, field undefined", () => {
  withStoreFile(
    {
      s1: {
        sessionId: "sess-1",
        title: "Session 1",
        cwd: { cwd: "/tmp/projeto", locked: true },
        lastActiveAt: Date.now(),
      },
    },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      assert.equal(store.getContextUsage("s1"), undefined);
      // And it's still writable normally from here on.
      store.setContextUsage("s1", { model: "claude-sonnet-5", contextWindowSize: 1_000_000, usedTokens: 42 });
      assert.deepEqual(store.getContextUsage("s1"), {
        model: "claude-sonnet-5",
        contextWindowSize: 1_000_000,
        usedTokens: 42,
      });
    },
  );
});

test("getDraft with no record yet: empty string, doesn't break (new tab, nothing typed)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(store.getDraft("nunca-visto"), "");
  });
});

test("setDraft round-trips and persists to disk, surviving reopening the file", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setDraft("s1", "preciso lembrar de");
    assert.equal(store.getDraft("s1"), "preciso lembrar de");

    // Simulates a relay restart: the value survives without needing a new turn.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(reopened.getDraft("s1"), "preciso lembrar de");
  });
});

test("setDraft called before recordId still works (ensureEntry creates the record)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.setDraft("nova", "rascunho");
    assert.equal(store.getDraft("nova"), "rascunho");
  });
});

test("getSuggestion with no record yet: null, doesn't break", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(store.getSuggestion("nunca-visto"), null);
  });
});

test("setSuggestion round-trips and persists to disk, surviving reopening the file", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setSuggestion("s1", "Quer que eu revise o resto do arquivo?");
    assert.equal(store.getSuggestion("s1"), "Quer que eu revise o resto do arquivo?");

    // Simulates a relay restart: the suggestion survives without a new turn.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(reopened.getSuggestion("s1"), "Quer que eu revise o resto do arquivo?");
  });
});

test("setSuggestion(null) persists the clear, surviving reopening the file", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setSuggestion("s1", "sugestao");
    store.setSuggestion("s1", null);

    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(reopened.getSuggestion("s1"), null);
  });
});

