import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDirectory, listDirectories } from "./fsBrowse.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-fsbrowse-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkDirectory rejects a relative path", () => {
  assert.deepEqual(checkDirectory("relative/path"), { ok: false, error: "invalid_path" });
});

test("checkDirectory: nonexistent path", () => {
  withTempDir((dir) => {
    assert.deepEqual(checkDirectory(join(dir, "nao-existe")), { ok: false, error: "not_found" });
  });
});

test("checkDirectory: path is a file, not a directory", () => {
  withTempDir((dir) => {
    const file = join(dir, "arquivo.txt");
    writeFileSync(file, "conteúdo");
    assert.deepEqual(checkDirectory(file), { ok: false, error: "not_a_directory" });
  });
});

test("listDirectories: only subfolders, a regular file is excluded", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "pasta-b"));
    mkdirSync(join(dir, "pasta-a"));
    writeFileSync(join(dir, "arquivo.txt"), "conteúdo");

    const result = listDirectories(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.entries.map((e) => e.name),
      ["pasta-a", "pasta-b"],
    );
  });
});

test("listDirectories: a symlink to a directory is included, a broken symlink is ignored", () => {
  withTempDir((dir) => {
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    symlinkSync(realDir, join(dir, "link-valido"));
    symlinkSync(join(dir, "nao-existe"), join(dir, "link-quebrado"));

    const result = listDirectories(dir);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.entries.map((e) => e.name),
      ["link-valido", "real"],
    );
  });
});

test("listDirectories: nonexistent path propagates not_found", () => {
  withTempDir((dir) => {
    assert.deepEqual(listDirectories(join(dir, "nao-existe")), { ok: false, error: "not_found" });
  });
});

test("listDirectories: no read permission", { skip: process.getuid?.() === 0 }, () => {
  withTempDir((dir) => {
    const restricted = join(dir, "restrita");
    mkdirSync(restricted);
    mkdirSync(join(restricted, "sub"));
    chmodSync(restricted, 0o000);
    try {
      assert.deepEqual(listDirectories(restricted), { ok: false, error: "permission_denied" });
    } finally {
      chmodSync(restricted, 0o755); // so withTempDir's rmSync can clean up afterward.
    }
  });
});
