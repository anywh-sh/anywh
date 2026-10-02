import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliVersion } from "./detection.js";

test("parseCliVersion: extracts the number from each CLI's real --version shape", () => {
  assert.equal(parseCliVersion("2.1.3 (Claude Code)"), "2.1.3");
  assert.equal(parseCliVersion("codex-cli 0.46.0"), "0.46.0");
  assert.equal(parseCliVersion("tool 1.2"), "1.2");
});

test("parseCliVersion: undefined when there is nothing version-shaped", () => {
  assert.equal(parseCliVersion(undefined), undefined);
  assert.equal(parseCliVersion(""), undefined);
  assert.equal(parseCliVersion("not a version"), undefined);
});
