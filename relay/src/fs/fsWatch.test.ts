import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FilesWatchSession, type FilesWatchMessage } from "./fsWatch.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-fswatch-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Debounce window is 150ms — comfortably clears it without being so long
// the suite drags.
const SETTLE_MS = 300;

test("update(): a child file change inside a watched dir notifies dir_changed", async () => {
  await withTempDir(async (root) => {
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    try {
      session.update([root], []);
      await delay(50); // let the watcher actually open before writing.
      writeFileSync(join(root, "new.txt"), "conteúdo");
      await delay(SETTLE_MS);
      assert.deepEqual(messages, [{ type: "dir_changed", path: root }]);
    } finally {
      session.close();
    }
  });
});

test("update(): a watched file's own content change notifies file_changed", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "notas.txt");
    writeFileSync(file, "v1");
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    try {
      session.update([], [file]);
      await delay(50);
      writeFileSync(file, "v2");
      await delay(SETTLE_MS);
      assert.deepEqual(messages, [{ type: "file_changed", path: file }]);
    } finally {
      session.close();
    }
  });
});

test("update(): rapid successive writes collapse into a single debounced notification", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "notas.txt");
    writeFileSync(file, "v1");
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    try {
      session.update([], [file]);
      await delay(50);
      writeFileSync(file, "v2");
      writeFileSync(file, "v3");
      writeFileSync(file, "v4");
      await delay(SETTLE_MS);
      assert.deepEqual(messages, [{ type: "file_changed", path: file }]);
    } finally {
      session.close();
    }
  });
});

test("update(): dropping a path from the set closes its watcher — no more notifications", async () => {
  await withTempDir(async (root) => {
    const file = join(root, "notas.txt");
    writeFileSync(file, "v1");
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    try {
      session.update([], [file]);
      await delay(50);
      session.update([], []); // stopped watching it.
      await delay(50);
      writeFileSync(file, "v2");
      await delay(SETTLE_MS);
      assert.deepEqual(messages, []);
    } finally {
      session.close();
    }
  });
});

test("update(): a path outside the root is silently skipped, never watched", async () => {
  await withTempDir(async (outer) => {
    await withTempDir(async (root) => {
      const messages: FilesWatchMessage[] = [];
      const session = new FilesWatchSession(root, (msg) => messages.push(msg));
      try {
        session.update([outer], []);
        await delay(50);
        writeFileSync(join(outer, "arquivo.txt"), "conteúdo");
        await delay(SETTLE_MS);
        assert.deepEqual(messages, []);
      } finally {
        session.close();
      }
    });
  });
});

test("close(): stops every watcher — no notifications arrive afterwards", async () => {
  await withTempDir(async (root) => {
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    session.update([root], []);
    await delay(50);
    session.close();
    writeFileSync(join(root, "new.txt"), "conteúdo");
    await delay(SETTLE_MS);
    assert.deepEqual(messages, []);
  });
});

test("update(): a subdirectory created after the fact isn't auto-watched (only what the client asked for)", async () => {
  await withTempDir(async (root) => {
    const messages: FilesWatchMessage[] = [];
    const session = new FilesWatchSession(root, (msg) => messages.push(msg));
    try {
      session.update([root], []);
      await delay(50);
      const sub = join(root, "sub");
      mkdirSync(sub);
      await delay(SETTLE_MS);
      // Creating `sub` is itself a change to `root`'s own listing.
      assert.deepEqual(messages, [{ type: "dir_changed", path: root }]);
      messages.length = 0;
      writeFileSync(join(sub, "inner.txt"), "conteúdo");
      await delay(SETTLE_MS);
      assert.deepEqual(messages, []);
    } finally {
      session.close();
    }
  });
});
