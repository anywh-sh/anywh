import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotFiles, memoryForPrompt, MEMORY_PROMPT_LINES, parseMemory } from "./botFiles.js";

function files(): { files: BotFiles; root: string } {
  const root = mkdtempSync(join(tmpdir(), "anywh-bot-files-"));
  return { files: new BotFiles(root, () => Date.parse("2026-11-21T12:00:00Z")), root };
}

test("remember stamps the date and the source; the same fact is not added twice; forget removes it", () => {
  const { files: bot, root } = files();
  try {
    bot.create("b1", "I watch the CI.");
    assert.equal(bot.readSoul("b1"), "I watch the CI.");
    assert.deepEqual(bot.remember("b1", { kind: "rule", text: "Never merge", source: "conversation" }), { added: true });
    assert.deepEqual(bot.remember("b1", { kind: "fact", text: "never MERGE" }), { added: false });
    bot.remember("b1", { kind: "fact", text: "CI runs on main" });
    assert.match(readFileSync(join(root, "b1", "MEMORY.md"), "utf8"), /- 2026-11-21 \[rule\] Never merge · from: conversation/);
    assert.equal(bot.forget("b1", "ci runs on main"), 1);
    assert.deepEqual(bot.readMemory("b1").map((line) => line.text), ["Never merge"]);
    assert.equal(bot.forget("b1", "nothing like it"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forgetting by a fragment two lines share is refused, not guessed", () => {
  const { files: bot, root } = files();
  try {
    bot.create("b1", "s");
    bot.remember("b1", { kind: "fact", text: "deploys run on Vercel" });
    bot.remember("b1", { kind: "fact", text: "previews run on Vercel" });
    assert.equal(bot.forget("b1", "Vercel"), -2);
    assert.equal(bot.readMemory("b1").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the person's own lines survive, and editing keeps a line's kind and date", () => {
  const { files: bot, root } = files();
  try {
    bot.create("b1", "s");
    writeFileSync(join(root, "b1", "MEMORY.md"), "# Memory\n\n- my own note\n- 2026-01-02 [preference] short replies · from: conversation\n");
    assert.equal(bot.editLine("b1", 1, "very short replies"), true);
    assert.deepEqual(parseMemory(readFileSync(join(root, "b1", "MEMORY.md"), "utf8")).map((line) => line.raw), ["- my own note", "- 2026-01-02 [preference] very short replies · from: conversation"]);
    assert.equal(bot.editLine("b1", 0, null), true);
    assert.equal(bot.readMemory("b1").length, 1);
    assert.equal(bot.editLine("b1", 5, "x"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long memory reaches the prompt cut, saying how much was left out", () => {
  const lines = parseMemory(Array.from({ length: MEMORY_PROMPT_LINES + 5 }, (_, i) => `- line ${i}`).join("\n"));
  assert.match(memoryForPrompt(lines), /\(5 more lines in MEMORY\.md not loaded\)$/);
  assert.equal(memoryForPrompt([]), "(empty)");
});

test("the person's headings and paragraphs survive remembering, forgetting and editing", () => {
  const { files: bot, root } = files();
  try {
    bot.create("b1", "s");
    const own = "# Memory\n\n## Repos\nWe ship from main only.\n\n- 2026-01-02 [rule] never merge · from: conversation\n\n## Notes\n- my own note\n";
    writeFileSync(join(root, "b1", "MEMORY.md"), own);
    bot.remember("b1", { kind: "fact", text: "CI runs hourly" });
    assert.equal(bot.forget("b1", "my own note"), 1);
    assert.equal(bot.editLine("b1", 0, "never merge to main"), true);
    const after = readFileSync(join(root, "b1", "MEMORY.md"), "utf8");
    assert.match(after, /## Repos\nWe ship from main only\.\n/);
    assert.match(after, /## Notes\n/);
    assert.match(after, /- 2026-01-02 \[rule\] never merge to main · from: conversation/);
    assert.match(after, /\[fact\] CI runs hourly/);
    assert.doesNotMatch(after, /my own note/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
