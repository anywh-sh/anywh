import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordProfile } from "./recordProfile.js";

function withFile(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-record-profile-"));
  try {
    fn(join(dir, "profiles.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Entry {
  id: string;
  label: string;
  colorIndex: number;
  createdAt: string;
  updatedAt: string;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { version: number; profiles: Entry[] };

test("a new profile gets the smallest free colorIndex", () => {
  withFile((path) => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, profiles: [{ id: "a", label: "A", colorIndex: 0 }, { id: "b", label: "B", colorIndex: 2 }] }),
    );
    recordProfile(path, "c", "C", new Date("2026-11-24T00:00:00Z"));
    const c = read(path).profiles.find((p) => p.id === "c");
    assert.deepEqual(c, { id: "c", label: "C", colorIndex: 1, createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z" });
  });
});

test("re-recording a profile keeps its colorIndex and createdAt, updates the label", () => {
  withFile((path) => {
    recordProfile(path, "work", "Work", new Date("2026-01-01T00:00:00Z"));
    recordProfile(path, "home", "Home", new Date("2026-01-02T00:00:00Z"));
    recordProfile(path, "work", "Job", new Date("2026-02-01T00:00:00Z"));
    const profiles = read(path).profiles;
    assert.equal(profiles.length, 2);
    const work = profiles.find((p) => p.id === "work");
    assert.deepEqual(work, { id: "work", label: "Job", colorIndex: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" });
  });
});

test("a missing or corrupt file starts an empty registry", () => {
  withFile((path) => {
    recordProfile(path, "a", "A");
    assert.deepEqual(read(path).profiles.map((p) => p.id), ["a"]);
    writeFileSync(path, "{not json");
    recordProfile(path, "b", "B");
    assert.equal(read(path).version, 1);
    assert.deepEqual(read(path).profiles.map((p) => [p.id, p.colorIndex]), [["b", 0]]);
  });
});
