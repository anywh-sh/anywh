import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeId, sessionNamePrefix, tmuxSessionName, tmuxSocketName } from "./terminalSession.js";

test("sanitizeId replaces tmux's target-syntax separators, leaves everything else alone", () => {
  assert.equal(sanitizeId("a:b.c"), "a_b_c");
  assert.equal(sanitizeId("no-special-chars-123"), "no-special-chars-123");
  assert.equal(sanitizeId(""), "");
});

test("sanitizeId is idempotent on a real UUID (the actual id shape in practice)", () => {
  const uuid = "f14b49f3-077b-4eb3-baaa-c527499713f8";
  assert.equal(sanitizeId(uuid), uuid, "a UUID has no ':' or '.' to begin with");
});

test("tmuxSocketName is one dedicated socket per relay port, so two profiles never collide", () => {
  assert.equal(tmuxSocketName(8765), "anywh-term-8765");
  assert.notEqual(tmuxSocketName(8765), tmuxSocketName(8766));
});

test("tmuxSessionName joins the sanitized chat/terminal ids with a double underscore", () => {
  assert.equal(tmuxSessionName("chat-1", "term-1"), "chat-1__term-1");
  assert.equal(tmuxSessionName("chat:1", "term.1"), "chat_1__term_1", "both halves go through sanitizeId");
});

test("sessionNamePrefix matches exactly the prefix tmuxSessionName produces for that chat session", () => {
  const chatSessionId = "chat:1";
  const prefix = sessionNamePrefix(chatSessionId);
  assert.ok(tmuxSessionName(chatSessionId, "any-terminal").startsWith(prefix));
  assert.ok(!tmuxSessionName("chat:2", "any-terminal").startsWith(prefix), "a different chat session's name must not share the prefix");
});
