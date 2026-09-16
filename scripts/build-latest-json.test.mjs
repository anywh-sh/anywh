import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLatestJson } from "./build-latest-json.mjs";

const PLATFORM_FILES = {
  "anywh_aarch64.app.tar.gz": "darwin-aarch64",
  "anywh_x64.app.tar.gz": "darwin-x86_64",
  "anywh_0.2.0_amd64.AppImage": "linux-x86_64",
  "anywh_0.2.0_aarch64.AppImage": "linux-aarch64",
  "anywh_0.2.0_x64-setup.exe": "windows-x86_64",
};

function withFixtureDist(fn) {
  const distDir = mkdtempSync(join(tmpdir(), "latest-json-fixture-"));
  try {
    for (const fileName of Object.keys(PLATFORM_FILES)) {
      writeFileSync(join(distDir, fileName), "binary content");
      writeFileSync(join(distDir, `${fileName}.sig`), `signature-for-${fileName}`);
    }
    fn(distDir);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
}

test("maps all five platform keys to their versioned asset and inlines the .sig content", () => {
  withFixtureDist((distDir) => {
    const manifest = buildLatestJson({
      distDir,
      version: "0.2.0",
      repoUrl: "https://github.com/anywh-sh/anywh",
      pubDate: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.pub_date, "2026-01-01T00:00:00.000Z");
    assert.equal(Object.keys(manifest.platforms).length, 5);

    for (const [fileName, key] of Object.entries(PLATFORM_FILES)) {
      assert.equal(manifest.platforms[key].signature, `signature-for-${fileName}`);
      assert.equal(manifest.platforms[key].url, `https://github.com/anywh-sh/anywh/releases/download/v0.2.0/${fileName}`);
    }
  });
});

test("points at the tag-scoped download URL, never the unversioned alias", () => {
  withFixtureDist((distDir) => {
    const manifest = buildLatestJson({ distDir, version: "0.2.0", repoUrl: "https://github.com/anywh-sh/anywh" });
    for (const entry of Object.values(manifest.platforms)) {
      assert.match(entry.url, /\/releases\/download\/v0\.2\.0\//);
    }
  });
});

test("defaults notes to an empty string and pub_date to an ISO timestamp", () => {
  withFixtureDist((distDir) => {
    const manifest = buildLatestJson({ distDir, version: "0.2.0", repoUrl: "https://github.com/anywh-sh/anywh" });
    assert.equal(manifest.notes, "");
    assert.doesNotThrow(() => new Date(manifest.pub_date).toISOString());
  });
});

test("fails hard when an asset is missing", () => {
  withFixtureDist((distDir) => {
    rmSync(join(distDir, "anywh_0.2.0_x64-setup.exe"));
    assert.throws(
      () => buildLatestJson({ distDir, version: "0.2.0", repoUrl: "https://github.com/anywh-sh/anywh" }),
      /windows-x86_64/,
    );
  });
});

test("fails hard when a .sig is missing even if the asset itself is present", () => {
  withFixtureDist((distDir) => {
    rmSync(join(distDir, "anywh_0.2.0_x64-setup.exe.sig"));
    assert.throws(
      () => buildLatestJson({ distDir, version: "0.2.0", repoUrl: "https://github.com/anywh-sh/anywh" }),
      /windows-x86_64/,
    );
  });
});
