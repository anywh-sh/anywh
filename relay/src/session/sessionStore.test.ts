import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("effort is scoped per agentId, null clears it, and a record without one reads undefined", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    store.recordId("s1");
    assert.equal(store.getEffort("s1", "claude"), undefined);
    store.setEffort("s1", "claude", "high");
    store.setEffort("s1", "codex", "ultra");
    assert.equal(new SessionStore(filePath, DEFAULT_CWD).getEffort("s1", "claude"), "high");
    store.setEffort("s1", "claude", null);
    assert.equal(store.getEffort("s1", "claude"), undefined);
    assert.equal(store.getEffort("s1", "codex"), "ultra");
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


test("pendingChoice: round-trips through disk, clears on undefined, and is absent on older records", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-store-pending-"));
  try {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file, "/home/user");
    assert.equal(store.getPendingChoice("s1"), undefined);
    store.setPendingChoice("s1", undefined);
    assert.equal(store.listIds().includes("s1"), false, "clearing a never-set value must not create a record");

    const choice = { promptId: "p1", questions: [{ question: "ok?", options: [{ id: "a", label: "A" }] }], askedAt: 1700000000000 };
    store.setPendingChoice("s1", choice);
    assert.deepEqual(new SessionStore(file, "/home/user").getPendingChoice("s1"), choice);

    store.setPendingChoice("s1", undefined);
    assert.equal(new SessionStore(file, "/home/user").getPendingChoice("s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load keeps the question when only askedAt is malformed, clearing just the timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-store-pending-askedat-"));
  try {
    const file = join(dir, "sessions.json");
    const good = { promptId: "p1", questions: [{ question: "ok?", options: [{ id: "a", label: "A" }] }] };
    const seed = new SessionStore(file, "/home/user");
    const bad: Record<string, unknown> = { str: "yesterday", neg: -5, nan: null, obj: {} };
    const decimal = 1700000000000.9;
    for (const id of [...Object.keys(bad), "dec"]) seed.setPendingChoice(id, good);
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingChoice: Record<string, unknown> }>;
    for (const [id, value] of Object.entries(bad)) records[id].pendingChoice.askedAt = value;
    records.dec.pendingChoice.askedAt = decimal;
    writeFileSync(file, JSON.stringify(records));
    const store = new SessionStore(file, "/home/user");
    for (const id of Object.keys(bad)) assert.deepEqual(store.getPendingChoice(id), good, id);
    assert.equal(store.getPendingChoice("dec")?.askedAt, 1700000000000, "decimals are truncated");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingChoice: Record<string, unknown> }>;
    assert.equal("askedAt" in onDisk.str.pendingChoice, false, "rewritten so the bad value does not come back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load drops a malformed pendingChoice (and rewrites the file) without touching valid ones or crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-store-pending-bad-"));
  try {
    const file = join(dir, "sessions.json");
    const good = { promptId: "p1", questions: [{ question: "ok?", options: [{ id: "a", label: "A" }] }] };
    const seed = new SessionStore(file, "/home/user");
    for (const id of ["good", "empty", "noQuestions", "emptyQuestions", "strQuestions", "badQuestion", "noPromptId", "scalar", "badOptions", "badOptions2"]) seed.setPendingChoice(id, good);
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingChoice: unknown }>;
    records.empty.pendingChoice = {};
    records.noQuestions.pendingChoice = { promptId: "p" };
    records.emptyQuestions.pendingChoice = { promptId: "p", questions: [] };
    records.strQuestions.pendingChoice = { promptId: "p", questions: "nope" };
    records.badQuestion.pendingChoice = { promptId: "p", questions: [{ question: 1 }] };
    records.noPromptId.pendingChoice = { questions: good.questions };
    records.scalar.pendingChoice = "x";
    records.badOptions.pendingChoice = { promptId: "p", questions: [{ question: "q", options: [{}] }] };
    records.badOptions2.pendingChoice = { promptId: "p", questions: [{ question: "q", options: ["A"] }] };
    writeFileSync(file, JSON.stringify(records));

    const store = new SessionStore(file, "/home/user");
    assert.deepEqual(store.getPendingChoice("good"), good, "a record without askedAt (older file) stays valid");
    for (const id of ["empty", "noQuestions", "emptyQuestions", "strQuestions", "badQuestion", "noPromptId", "scalar", "badOptions", "badOptions2"]) {
      assert.equal(store.getPendingChoice(id), undefined, id);
    }
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingChoice?: unknown }>;
    assert.equal(onDisk.empty.pendingChoice, undefined, "the bad record must not come back on the next boot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setPendingChoice stores a copy, not the caller's reference", () => {
  withStoreFile(undefined, (filePath) => {
    const store = new SessionStore(filePath, DEFAULT_CWD);
    const choice = { promptId: "p1", questions: [{ question: "ok?", options: [{ label: "A" }] }] };
    store.setPendingChoice("s1", choice);
    choice.questions[0].question = "mutated";
    assert.equal(store.getPendingChoice("s1")!.questions[0].question, "ok?");
  });
});

test("a failed write of the clear is not lost: the next successful persist writes the cleared state", () => {
  const dir = mkdtempSync(join(tmpdir(), "anywh-store-failed-clear-"));
  try {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file, DEFAULT_CWD);
    store.setPendingChoice("s1", { promptId: "p1", questions: [{ question: "ok?", options: [{ label: "A" }] }] });
    rmSync(file);
    mkdirSync(file); // writeFileSync now fails with EISDIR
    assert.throws(() => store.setPendingChoice("s1", undefined));
    rmSync(file, { recursive: true });
    store.setDraft("s1", "later write");
    assert.equal(new SessionStore(file, DEFAULT_CWD).getPendingChoice("s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const APPROVAL = {
  promptId: "a1",
  questions: [
    { question: "Run Write?", approval: { tool: "Write", detail: "/tmp/x" }, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
    { question: "Run Bash?", approval: { tool: "Bash", detail: "ls" }, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] },
  ],
  calls: [
    { tool: "Write", input: { file_path: "/tmp/x", content: "hi" }, toolUseId: "toolu_1" },
    { tool: "Bash", input: { command: "ls" }, agentId: "agent-7" },
  ],
  askedAt: 1700000000000,
};

test("pendingApproval: round-trips through disk (calls, agent id, askedAt), clears on undefined, absent on older records", () => {
  withStoreFile(undefined, (file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    assert.equal(store.getPendingApproval("s1"), undefined);
    store.setPendingApproval("s1", undefined);
    assert.equal(store.listIds().includes("s1"), false, "clearing a never-set value must not create a record");

    store.setPendingApproval("s1", APPROVAL);
    assert.deepEqual(new SessionStore(file, DEFAULT_CWD).getPendingApproval("s1"), APPROVAL);
    // Independent of the deferred question slot.
    assert.equal(new SessionStore(file, DEFAULT_CWD).getPendingChoice("s1"), undefined);

    store.setPendingApproval("s1", undefined);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getPendingApproval("s1"), undefined);
  });
});

test("pendingApproval: load drops a malformed record (and rewrites the file) without touching valid ones", () => {
  withStoreFile(undefined, (file) => {
    const seed = new SessionStore(file, DEFAULT_CWD);
    const ids = ["good", "noCalls", "callsNotArray", "lengthMismatch", "badTool", "badAgentId", "badToolUseId", "noQuestions"];
    for (const id of ids) seed.setPendingApproval(id, APPROVAL);
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingApproval: Record<string, unknown> }>;
    delete records.noCalls.pendingApproval.calls;
    records.callsNotArray.pendingApproval.calls = "nope";
    records.lengthMismatch.pendingApproval.calls = [APPROVAL.calls[0]];
    records.badTool.pendingApproval.calls = [{ tool: "", input: {} }, APPROVAL.calls[1]];
    records.badAgentId.pendingApproval.calls = [{ tool: "Write", input: {}, agentId: 3 }, APPROVAL.calls[1]];
    records.badToolUseId.pendingApproval.calls = [{ tool: "Write", input: {}, toolUseId: {} }, APPROVAL.calls[1]];
    records.noQuestions.pendingApproval.questions = [];
    writeFileSync(file, JSON.stringify(records));

    const store = new SessionStore(file, DEFAULT_CWD);
    assert.deepEqual(store.getPendingApproval("good"), APPROVAL);
    for (const id of ids.slice(1)) assert.equal(store.getPendingApproval(id), undefined, id);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingApproval?: unknown }>;
    assert.equal(onDisk.noCalls.pendingApproval, undefined, "the bad record must not come back on the next boot");
  });
});

test("pendingApproval: a malformed askedAt costs only the timestamp, same as pendingChoice", () => {
  withStoreFile(undefined, (file) => {
    const seed = new SessionStore(file, DEFAULT_CWD);
    const { askedAt: _omit, ...withoutAskedAt } = APPROVAL;
    seed.setPendingApproval("s1", APPROVAL);
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingApproval: Record<string, unknown> }>;
    records.s1.pendingApproval.askedAt = "yesterday";
    writeFileSync(file, JSON.stringify(records));
    assert.deepEqual(new SessionStore(file, DEFAULT_CWD).getPendingApproval("s1"), withoutAskedAt);
  });
});

test("setPendingApproval stores a copy, not the caller's reference", () => {
  withStoreFile(undefined, (file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    const mine = structuredClone(APPROVAL);
    store.setPendingApproval("s1", mine);
    mine.calls[0].tool = "Mutated";
    assert.equal(store.getPendingApproval("s1")?.calls[0].tool, "Write");
  });
});

test("queuedApproval: the calls waiting behind the card on screen round-trip and are validated like pendingApproval", () => {
  withStoreFile(undefined, (file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    assert.equal(store.getQueuedApproval("s1"), undefined);
    store.setQueuedApproval("s1", APPROVAL);
    store.setQueuedApproval("bad", APPROVAL);
    assert.deepEqual(new SessionStore(file, DEFAULT_CWD).getQueuedApproval("s1"), APPROVAL);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getPendingApproval("s1"), undefined, "a different slot");
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { queuedApproval: Record<string, unknown> }>;
    records.bad.queuedApproval.calls = [];
    writeFileSync(file, JSON.stringify(records));
    assert.equal(new SessionStore(file, DEFAULT_CWD).getQueuedApproval("bad"), undefined);
    store.setQueuedApproval("s1", undefined);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getQueuedApproval("s1"), undefined);
  });
});

test("withdrawnApproval: round-trips, and false clears it without creating a record", () => {
  withStoreFile(undefined, (file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    store.setWithdrawnApproval("s1", false);
    assert.equal(store.listIds().includes("s1"), false);
    store.setWithdrawnApproval("s1", true);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getWithdrawnApproval("s1"), true);
    store.setWithdrawnApproval("s1", false);
    assert.equal(new SessionStore(file, DEFAULT_CWD).getWithdrawnApproval("s1"), false);
  });
});

test("pendingApproval: the permission rule decided for each call is stored with it and validated on load", () => {
  withStoreFile(undefined, (file) => {
    const store = new SessionStore(file, DEFAULT_CWD);
    const withGrant = { ...APPROVAL, calls: [{ ...APPROVAL.calls[0], grant: { rule: "Edit(//tmp/x)", broad: false } }, { ...APPROVAL.calls[1], grant: { rule: "Bash", broad: true } }] };
    store.setPendingApproval("good", withGrant);
    store.setPendingApproval("badRule", withGrant);
    store.setPendingApproval("badBroad", withGrant);
    const records = JSON.parse(readFileSync(file, "utf8")) as Record<string, { pendingApproval: { calls: { grant: Record<string, unknown> }[] } }>;
    records.badRule.pendingApproval.calls[0].grant.rule = "";
    records.badBroad.pendingApproval.calls[1].grant.broad = "yes";
    writeFileSync(file, JSON.stringify(records));
    const reopened = new SessionStore(file, DEFAULT_CWD);
    assert.deepEqual(reopened.getPendingApproval("good"), withGrant);
    assert.equal(reopened.getPendingApproval("badRule"), undefined);
    assert.equal(reopened.getPendingApproval("badBroad"), undefined);
  });
});
