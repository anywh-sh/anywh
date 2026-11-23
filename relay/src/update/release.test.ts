import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewerRelease, parseInstallerLine, parseRelease } from "./release.js";

test("a release parses with or without its v; the unreleased placeholder and anything else do not", () => {
  assert.deepEqual(parseRelease("0.2.48"), [0, 2, 48]);
  assert.deepEqual(parseRelease("v1.10.0"), [1, 10, 0]);
  assert.equal(parseRelease("0.0.0"), null);
  assert.equal(parseRelease("1.2"), null);
  assert.equal(parseRelease("1.2.3-beta.1"), null);
  assert.equal(parseRelease("1.2.3; rm -rf /"), null);
  assert.equal(parseRelease(""), null);
});

test("newer compares part by part as numbers, never as text", () => {
  assert.equal(isNewerRelease("0.2.10", "0.2.9"), true);
  assert.equal(isNewerRelease("0.10.0", "0.9.99"), true);
  assert.equal(isNewerRelease("1.0.0", "0.99.99"), true);
  assert.equal(isNewerRelease("0.2.9", "0.2.10"), false);
  assert.equal(isNewerRelease("0.2.9", "0.2.9"), false);
  // A source checkout is never older or newer than anything.
  assert.equal(isNewerRelease("0.2.9", "0.0.0"), false);
  assert.equal(isNewerRelease("0.0.0", "0.2.9"), false);
});

test("the installer's porcelain end lines are read; progress and prose are not", () => {
  assert.deepEqual(parseInstallerLine("ANYWH done ok service=systemd install_dir=/x"), { kind: "ok" });
  assert.deepEqual(parseInstallerLine("ANYWH done ok"), { kind: "ok" });
  assert.deepEqual(parseInstallerLine("ANYWH fail download checksum_mismatch checksum mismatch for a.tar.gz"), {
    kind: "fail",
    step: "download",
    code: "checksum_mismatch",
    message: "checksum mismatch for a.tar.gz",
  });
  assert.equal(parseInstallerLine("ANYWH done download asset=a.tar.gz"), null);
  assert.equal(parseInstallerLine("ANYWH step install"), null);
  assert.equal(parseInstallerLine("Checksum verified."), null);
});
