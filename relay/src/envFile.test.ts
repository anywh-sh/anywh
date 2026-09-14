import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEnvFileContent } from "./envFile.js";

test("applies KEY=VALUE lines, skipping blanks and comments", () => {
  const target: NodeJS.ProcessEnv = {};
  applyEnvFileContent("RELAY_PORT=8765\n\n# a comment\nRELAY_HOST=100.64.0.1\n", target);
  assert.deepEqual(target, { RELAY_PORT: "8765", RELAY_HOST: "100.64.0.1" });
});

test("an existing key in target wins over the file's value", () => {
  const target: NodeJS.ProcessEnv = { RELAY_PORT: "9999" };
  applyEnvFileContent("RELAY_PORT=8765\n", target);
  assert.equal(target.RELAY_PORT, "9999");
});

test("a value containing '=' keeps everything after the first one", () => {
  const target: NodeJS.ProcessEnv = {};
  applyEnvFileContent("EXTRA_PATH_DIRS=/a=b:/c\n", target);
  assert.equal(target.EXTRA_PATH_DIRS, "/a=b:/c");
});

test("a line with no '=' is ignored", () => {
  const target: NodeJS.ProcessEnv = {};
  applyEnvFileContent("not-a-valid-line\n", target);
  assert.deepEqual(target, {});
});
