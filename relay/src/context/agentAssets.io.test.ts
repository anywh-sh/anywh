import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAssetFiles, listAssetFilesAcross, readFrontmatterDescription } from "./agentAssets.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "anywh-agent-assets-"));
}

test("readFrontmatterDescription extracts an unquoted description field", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: tests\ndescription: Testing doctrine for this repo\n---\n\nBody text.\n");
    assert.equal(readFrontmatterDescription(path), "Testing doctrine for this repo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrontmatterDescription strips surrounding quotes", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "SKILL.md");
    writeFileSync(path, '---\ndescription: "A quoted description"\n---\n');
    assert.equal(readFrontmatterDescription(path), "A quoted description");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrontmatterDescription returns empty string for a file with no frontmatter", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "# Just a heading\n\nNo frontmatter here.\n");
    assert.equal(readFrontmatterDescription(path), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrontmatterDescription returns empty string for frontmatter with no description field", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: tests\n---\n");
    assert.equal(readFrontmatterDescription(path), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrontmatterDescription returns empty string for a missing file", () => {
  assert.equal(readFrontmatterDescription("/nonexistent/path/SKILL.md"), "");
});

test("listAssetFiles finds every skill folder's SKILL.md, ignoring stray entries with no such file", () => {
  const dir = makeDir();
  try {
    mkdirSync(join(dir, "skill-a"));
    writeFileSync(join(dir, "skill-a", "SKILL.md"), "---\ndescription: a\n---\n");
    mkdirSync(join(dir, "skill-b"));
    writeFileSync(join(dir, "skill-b", "SKILL.md"), "---\ndescription: b\n---\n");
    mkdirSync(join(dir, "not-a-skill"));
    writeFileSync(join(dir, "stray.txt"), "not a skill");

    const found = listAssetFiles(dir, "skill-folders").sort();
    assert.deepEqual(found, [join(dir, "skill-a", "SKILL.md"), join(dir, "skill-b", "SKILL.md")].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAssetFiles finds every flat .md file for the subagent shape, ignoring non-.md entries", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "reviewer.md"), "---\ndescription: reviews code\n---\n");
    writeFileSync(join(dir, "planner.md"), "---\ndescription: plans work\n---\n");
    writeFileSync(join(dir, "notes.txt"), "not an agent");

    const found = listAssetFiles(dir, "flat-md").sort();
    assert.deepEqual(found, [join(dir, "planner.md"), join(dir, "reviewer.md")].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAssetFiles degrades to an empty list for a missing directory, rather than throwing", () => {
  assert.deepEqual(listAssetFiles("/nonexistent/dir", "flat-md"), []);
});

test("listAssetFilesAcross combines every root x relDir combination", () => {
  const projectDir = makeDir();
  const homeDir = makeDir();
  try {
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "agents", "project-agent.md"), "---\ndescription: p\n---\n");
    mkdirSync(join(homeDir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "agents", "user-agent.md"), "---\ndescription: u\n---\n");

    const found = listAssetFilesAcross([projectDir, homeDir], [".claude/agents"], "flat-md").sort();
    assert.deepEqual(
      found,
      [join(projectDir, ".claude", "agents", "project-agent.md"), join(homeDir, ".claude", "agents", "user-agent.md")].sort(),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
