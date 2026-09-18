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
    assert.equal(store.getSessionId("abc-123", "claude"), undefined);
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
    assert.equal(store.getSessionId("com-historico", "claude"), "abc-123");
    assert.equal(store.getTitle("com-historico"), "com-historico");

    // Session with no session_id yet: unlocked, but already titled with its own name.
    assert.deepEqual(store.getCwdState("sem-turno-ainda"), { cwd: DEFAULT_CWD, locked: false });
    assert.equal(store.getSessionId("sem-turno-ainda", "claude"), undefined);
    assert.equal(store.getTitle("sem-turno-ainda"), "sem-turno-ainda");

    // Re-persisted in the new shape — reopening doesn't re-detect it as legacy.
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    const { lastActiveAt, ...rest } = persisted["com-historico"];
    assert.equal(typeof lastActiveAt, "number");
    assert.deepEqual(rest, {
      agentId: "claude",
      sessionId: { claude: "abc-123" },
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
      assert.equal(store.getSessionId("s1", "claude"), "sess-1");
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

test("migration: pre-agent shape (flat sessionId/permissionMode/model, has lastActiveAt) scopes everything under agentId 'claude'", () => {
  withStoreFile(
    {
      s1: {
        sessionId: "sess-1",
        title: "Session 1",
        cwd: { cwd: "/tmp/projeto", locked: true },
        lastActiveAt: 1234,
        permissionMode: "acceptEdits",
        model: "claude-opus-5",
      },
    },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      assert.equal(store.getAgentId("s1"), "claude");
      assert.equal(store.getSessionId("s1", "claude"), "sess-1");
      assert.equal(store.getPermissionMode("s1", "claude", "bypassPermissions"), "acceptEdits");
      assert.equal(store.getModel("s1", "claude"), "claude-opus-5");

      const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      assert.deepEqual(persisted.s1, {
        agentId: "claude",
        sessionId: { claude: "sess-1" },
        title: "Session 1",
        cwd: { cwd: "/tmp/projeto", locked: true },
        lastActiveAt: 1234,
        permissionMode: { claude: "acceptEdits" },
        model: { claude: "claude-opus-5" },
      });
    },
  );
});

test("migration: pre-agent shape without permissionMode/model leaves those fields absent, not empty records", () => {
  withStoreFile(
    { s1: { sessionId: null, title: "Session 1", cwd: { cwd: "/tmp/projeto", locked: false }, lastActiveAt: 1234 } },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      // Fallback comes from the caller now, not a hardcoded Claude-specific
      // default — a non-Claude value proves that, rather than coincidentally
      // matching an internal constant.
      assert.equal(store.getPermissionMode("s1", "claude", "workspace-write"), "workspace-write");
      assert.equal(store.getModel("s1", "claude"), undefined);

      const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      assert.deepEqual(persisted.s1, {
        agentId: "claude",
        sessionId: { claude: null },
        title: "Session 1",
        cwd: { cwd: "/tmp/projeto", locked: false },
        lastActiveAt: 1234,
      });
    },
  );
});

test("getAgentId defaults to 'claude' for an id that was never recorded", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(store.getAgentId("nunca-visto"), "claude");
  });
});

test("setAgentId persists the choice — getAgentId reflects it, including across a reload from disk", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setAgentId("s1", "codex");
    assert.equal(store.getAgentId("s1"), "codex");

    const reloaded = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(reloaded.getAgentId("s1"), "codex");
  });
});

test("setAgentId creates the entry if it doesn't exist yet, same as the other setters", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.setAgentId("never-recorded", "codex");
    assert.equal(store.getAgentId("never-recorded"), "codex");
  });
});

test("sessionId/permissionMode/model are scoped per agentId — a second agent never clobbers the first's", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.recordSessionId("s1", "claude", "sess-claude-1");
    store.recordSessionId("s1", "codex", "thread-codex-1");
    store.setPermissionMode("s1", "claude", "plan");
    store.setPermissionMode("s1", "codex", "workspace-write");
    store.setModel("s1", "claude", "claude-opus-5");
    store.setModel("s1", "codex", "gpt-5-codex");

    assert.equal(store.getSessionId("s1", "claude"), "sess-claude-1");
    assert.equal(store.getSessionId("s1", "codex"), "thread-codex-1");
    // Fallback args deliberately don't match what was set, so a pass here
    // proves the persisted value won, not the fallback.
    assert.equal(store.getPermissionMode("s1", "claude", "read-only"), "plan");
    assert.equal(store.getPermissionMode("s1", "codex", "read-only"), "workspace-write");
    assert.equal(store.getModel("s1", "claude"), "claude-opus-5");
    assert.equal(store.getModel("s1", "codex"), "gpt-5-codex");

    store.clearSessionId("s1", "claude");
    assert.equal(store.getSessionId("s1", "claude"), undefined);
    assert.equal(store.getSessionId("s1", "codex"), "thread-codex-1");
  });
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
    store.recordSessionId("s1", "claude", "sess-1");
    assert.equal(store.getSessionId("s1", "claude"), "sess-1");
    assert.deepEqual(store.getCwdState("s1"), { cwd: "/tmp/projeto", locked: false });
  });
});

test("getContextUsage with no record yet: undefined, doesn't break (new session, no turn has run)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    assert.equal(store.getContextUsage("nunca-visto", "claude"), undefined);
  });
});

test("setContextUsage round-trips and persists to disk, surviving reopening the file", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    store.setContextUsage("s1", "claude", { model: "claude-sonnet-5", contextWindowSize: 1_000_000, usedTokens: 30693 });
    assert.deepEqual(store.getContextUsage("s1", "claude"), {
      model: "claude-sonnet-5",
      contextWindowSize: 1_000_000,
      usedTokens: 30693,
    });

    // Simulates a relay restart: the value survives without waiting for a new turn.
    const reopened = new SessionStore(filePath, DEFAULT_CWD);
    assert.deepEqual(reopened.getContextUsage("s1", "claude"), {
      model: "claude-sonnet-5",
      contextWindowSize: 1_000_000,
      usedTokens: 30693,
    });
  });
});

test("setContextUsage called before recordId still works (ensureEntry creates the record)", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.setContextUsage("nova", "claude", { model: "claude-opus-5", contextWindowSize: 200_000, usedTokens: 1000 });
    assert.deepEqual(store.getContextUsage("nova", "claude"), {
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
      assert.equal(store.getContextUsage("s1", "claude"), undefined);
      // And it's still writable normally from here on.
      store.setContextUsage("s1", "claude", { model: "claude-sonnet-5", contextWindowSize: 1_000_000, usedTokens: 42 });
      assert.deepEqual(store.getContextUsage("s1", "claude"), {
        model: "claude-sonnet-5",
        contextWindowSize: 1_000_000,
        usedTokens: 42,
      });
    },
  );
});

test("session file with per-agent sessionId/permissionMode/model but flat contextUsage (written before this feature was agent-keyed) migrates it under the session's own agentId", () => {
  withStoreFile(
    {
      s1: {
        agentId: "codex",
        sessionId: { codex: "thread-1" },
        title: "Session 1",
        cwd: { cwd: "/tmp/projeto", locked: true },
        lastActiveAt: Date.now(),
        contextUsage: { model: "gpt-5-codex", contextWindowSize: 200_000, usedTokens: 5000 },
      },
    },
    (filePath) => {
      const store = new SessionStore(filePath, DEFAULT_CWD);
      assert.deepEqual(store.getContextUsage("s1", "codex"), { model: "gpt-5-codex", contextWindowSize: 200_000, usedTokens: 5000 });
      assert.equal(store.getContextUsage("s1", "claude"), undefined);
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

