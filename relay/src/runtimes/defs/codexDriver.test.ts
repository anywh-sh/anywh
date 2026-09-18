import { test } from "node:test";
import assert from "node:assert/strict";
import { isThreadNotFoundError } from "./codexDriver.js";

test("isThreadNotFoundError: matches the real wire message, confirmed live against codex-cli 0.154.0", () => {
  assert.equal(isThreadNotFoundError("thread not found: 00000000-0000-0000-0000-000000000000"), true);
});

test("isThreadNotFoundError: case-insensitive, same tolerance as isSessionInvalidError", () => {
  assert.equal(isThreadNotFoundError("Thread Not Found: abc"), true);
});

test("isThreadNotFoundError: every other failure text says nothing about the thread being dead", () => {
  assert.equal(isThreadNotFoundError("rate limit exceeded"), false);
  assert.equal(isThreadNotFoundError("unauthorized"), false);
  assert.equal(isThreadNotFoundError("Codex daemon exited before the turn completed"), false);
});
