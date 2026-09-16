import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteTheme, listThemes, readTheme, saveTheme, ThemeValidationFailure } from "./themeRegistry.js";

function withThemesDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "anywh-themes-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function theme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: "nord-ish",
    name: "Nord-ish",
    appearance: "dark",
    colors: {
      background: "#2e3440",
      foreground: "#eceff4",
      "muted-foreground": "#8f9bb0",
      primary: "#88c0d0",
      destructive: "#bf616a",
      border: "#434c5e",
    },
    ...overrides,
  };
}

test("saves, lists and reads a theme", () => {
  withThemesDir((dir) => {
    const saved = saveTheme(theme(), dir);
    assert.equal(saved.id, "nord-ish");
    assert.ok(saved.updatedAt, "updatedAt is stamped on save");

    assert.deepEqual(listThemes(dir).map((t) => t.id), ["nord-ish"]);
    assert.equal(readTheme("nord-ish", dir)?.name, "Nord-ish");
  });
});

test("an absent directory lists as empty rather than throwing", () => {
  assert.deepEqual(listThemes(join(tmpdir(), "anywh-themes-does-not-exist")), []);
});

test("saving the same id again overwrites it", () => {
  withThemesDir((dir) => {
    saveTheme(theme(), dir);
    saveTheme(theme({ name: "Nord-ish v2" }), dir);
    const all = listThemes(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "Nord-ish v2");
  });
});

test("rejects an invalid theme with the per-field errors attached", () => {
  withThemesDir((dir) => {
    assert.throws(
      () => saveTheme(theme({ colors: { background: "#2e3440" } }), dir),
      (error: unknown) => {
        assert.ok(error instanceof ThemeValidationFailure);
        assert.ok(error.errors.some((e) => e.path === "colors"));
        return true;
      },
    );
    assert.deepEqual(listThemes(dir), [], "nothing is written when validation fails");
  });
});

test("a broken file is skipped instead of taking down the whole list", () => {
  withThemesDir((dir) => {
    saveTheme(theme(), dir);
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "incomplete.json"), JSON.stringify({ version: 1, id: "incomplete" }));

    assert.deepEqual(listThemes(dir).map((t) => t.id), ["nord-ish"]);
  });
});

test("a file whose inner id drifted from its filename is skipped", () => {
  withThemesDir((dir) => {
    // Selection happens by id, so a hand-renamed file would otherwise list
    // under a name nothing can select.
    writeFileSync(join(dir, "renamed.json"), JSON.stringify(theme()));
    assert.deepEqual(listThemes(dir), []);
  });
});

test("ignores non-json files and unusable filenames", () => {
  withThemesDir((dir) => {
    saveTheme(theme(), dir);
    writeFileSync(join(dir, "notes.txt"), "not a theme");
    writeFileSync(join(dir, "Nope Caps.json"), JSON.stringify(theme({ id: "Nope Caps" })));

    assert.deepEqual(listThemes(dir).map((t) => t.id), ["nord-ish"]);
  });
});

test("deletes by id and refuses ids that could escape the directory", () => {
  withThemesDir((dir) => {
    saveTheme(theme(), dir);
    assert.equal(deleteTheme("../../etc/passwd", dir), false);
    assert.equal(deleteTheme("does-not-exist", dir), false);
    assert.equal(deleteTheme("nord-ish", dir), true);
    assert.deepEqual(listThemes(dir), []);
  });
});

test("writes a file the user can read back and hand-edit", () => {
  withThemesDir((dir) => {
    saveTheme(theme(), dir);
    const written: unknown = JSON.parse(readFileSync(join(dir, "nord-ish.json"), "utf8"));
    assert.equal((written as { colors: Record<string, string> }).colors.background, "#2e3440");
  });
});
