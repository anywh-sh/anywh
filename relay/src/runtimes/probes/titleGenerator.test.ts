import { test } from "node:test";
import assert from "node:assert/strict";

import { fallbackTitle, sanitizeTitle } from "./titleGenerator.js";

/**
 * `generateTitle` itself spawns `claude`, so only its fallback is reachable
 * here — which is fine, because the fallback is where the interesting rule
 * lives: what a session is called when there was nothing to name it after.
 */
test("names the session after the prompt when there is one", () => {
  assert.equal(fallbackTitle("  fix   the login  bug "), "fix the login bug");
});

test("truncates a pasted wall of text instead of titling with all of it", () => {
  const title = fallbackTitle("x".repeat(200));
  assert.equal(title?.length, 51);
  assert.ok(title?.endsWith("…"));
});

test("fallback cuts at a word boundary and keeps only the first line", () => {
  assert.equal(fallbackTitle("investigate the push notification bug when several sessions run\nmore details"), "investigate the push notification bug when…");
});

test("leaves the session untitled when the prompt has no text to salvage", () => {
  // Null, not a stand-in name. A title is persisted, so a stand-in written
  // here would keep whatever language this file was written in forever —
  // while the client draws its own "untitled" label in the language the user
  // actually picked.
  assert.equal(fallbackTitle("   \n\t "), null);
  assert.equal(fallbackTitle(""), null);
});

test("sanitizeTitle accepts a plain title and strips decoration", () => {
  assert.equal(sanitizeTitle("Ordem de abertura dos terminais"), "Ordem de abertura dos terminais");
  assert.equal(sanitizeTitle('"**Push remoto iOS**."'), "Push remoto iOS");
  assert.equal(sanitizeTitle("# Plano composer iOS"), "Plano composer iOS");
});

test("sanitizeTitle rejects the model answering instead of titling", () => {
  assert.equal(sanitizeTitle("Vou investigar a arquitetura.\n\n```bash\nls\n```"), null);
  assert.equal(sanitizeTitle("Não consigo acessar o link do Slack, pode colar o texto da pergunta"), null);
  assert.equal(sanitizeTitle("x".repeat(80)), null);
  assert.equal(sanitizeTitle("<tool_use>"), null);
  assert.equal(sanitizeTitle("   "), null);
  assert.equal(sanitizeTitle(undefined), null);
});
