import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGrantRules, grantRuleFor, planDeferredGrants } from "./grantRules.js";

// Touches the filesystem (symlink checks), hence the io tier.

function withDir(run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "anywh-grants-")));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Write/Edit/MultiEdit on a plain absolute path become the one path rule that grants in the CLI, and it is narrow", () => {
  withDir((dir) => {
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      assert.deepEqual(grantRuleFor({ tool, input: { file_path: `${dir}/out.txt` } }), { rule: `Edit(/${dir}/out.txt)`, broad: false }, tool);
    }
    assert.deepEqual(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/my file.txt` } })?.rule, `Edit(/${dir}/my file.txt)`);
  });
});

test("a path that would name more than one file gets NO grant at all, never the tool-wide fallback", () => {
  withDir((dir) => {
    const bad = [
      `${dir}/x/..`, // the parent: a whole subtree
      `${dir}/.`,
      `${dir}/`,
      `${dir}//x`,
      `${dir}/a/../b`,
      "relative/out.txt",
      "/",
      `${dir}/*.txt`,
      `${dir}/a?b`,
      `${dir}/[x]`,
      `${dir}/{a,b}`,
      `${dir}/a(1)`,
      `${dir}/a,b`,
    ];
    for (const file_path of bad) assert.equal(grantRuleFor({ tool: "Write", input: { file_path } }), undefined, file_path);
    assert.equal(grantRuleFor({ tool: "Edit", input: {} }), undefined, "no path at all");
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: 3 } }), undefined);
  });
});

test("a path through a symlinked directory, or that is itself a symlink, gets no grant; a not-yet-existing file in a real directory does", () => {
  withDir((dir) => {
    mkdirSync(`${dir}/real`);
    symlinkSync(`${dir}/real`, `${dir}/link`);
    writeFileSync(`${dir}/real/f.txt`, "x");
    symlinkSync(`${dir}/real/f.txt`, `${dir}/real/alias.txt`);
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/link/f.txt` } }), undefined, "symlinked directory");
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/alias.txt` } }), undefined, "symlink file");
    assert.ok(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/f.txt` } }));
    assert.ok(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/new.txt` } }));
    assert.ok(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/missing-dir/new.txt` } }), "an unresolvable parent is not a symlink");
  });
});

test("Bash: a plain command is granted by its exact text (narrow); rule syntax or shell operators fall back to the whole tool (broad)", () => {
  assert.deepEqual(grantRuleFor({ tool: "Bash", input: { command: "git status --short" } }), { rule: "Bash(git status --short)", broad: false });
  for (const command of ["rm -rf build/*", "echo (hi)", "a, b", "ls\nrm x", "echo hi > /tmp/out.txt", "cat a | wc -l", "a && b", "a; b", "echo $HOME", "echo `id`", "cat < in"]) {
    assert.deepEqual(grantRuleFor({ tool: "Bash", input: { command } }), { rule: "Bash", broad: true }, command);
  }
  assert.equal(grantRuleFor({ tool: "Bash", input: {} }), undefined);
  assert.equal(grantRuleFor({ tool: "Bash", input: { command: "  " } }), undefined);
});

test("MCP tools and every other tool are broad by name; ExitPlanMode has no rule", () => {
  assert.deepEqual(grantRuleFor({ tool: "mcp__github__create_issue", input: {} }), { rule: "mcp__github__create_issue", broad: true });
  assert.deepEqual(grantRuleFor({ tool: "WebFetch", input: {} }), { rule: "WebFetch", broad: true });
  assert.deepEqual(grantRuleFor({ tool: "NotebookEdit", input: { notebook_path: "/tmp/n.ipynb" } }), { rule: "NotebookEdit", broad: true });
  assert.equal(grantRuleFor({ tool: "ExitPlanMode", input: {} }), undefined);
});

test("buildGrantRules: dedupes, skips what has no rule", () => {
  withDir((dir) => {
    assert.deepEqual(
      buildGrantRules([
        { tool: "Write", input: { file_path: `${dir}/a` } },
        { tool: "Write", input: { file_path: `${dir}/a` } },
        { tool: "Write", input: { file_path: `${dir}/b` } },
        { tool: "Write", input: { file_path: "relative" } },
        { tool: "ExitPlanMode", input: {} },
      ]),
      [`Edit(/${dir}/a)`, `Edit(/${dir}/b)`],
    );
  });
});

test("planDeferredGrants: a broad grant needs EVERY call of that tool approved; approve `ls | head` + deny `rm -rf` grants nothing for Bash", () => {
  const ls = { tool: "Bash", input: { command: "ls | head" } };
  const rm = { tool: "Bash", input: { command: "rm -rf ~/x" } };
  assert.deepEqual(planDeferredGrants([{ ...ls, approved: true }, { ...rm, approved: false }]), ["asked-again", "denied"]);
  assert.deepEqual(planDeferredGrants([{ ...ls, approved: true }, { ...rm, approved: true }]), ["granted", "granted"]);
});

test("planDeferredGrants: the same rule holds for MCP and WebFetch, and a narrow grant is unaffected by a refusal of the same tool", () => {
  withDir((dir) => {
    const mcp = { tool: "mcp__s__t", input: {} };
    assert.deepEqual(planDeferredGrants([{ ...mcp, approved: true }, { ...mcp, input: { x: 1 }, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(planDeferredGrants([{ tool: "Write", input: { file_path: `${dir}/a` }, approved: true }, { tool: "Write", input: { file_path: `${dir}/b` }, approved: false }]), ["granted", "denied"]);
    assert.deepEqual(planDeferredGrants([{ tool: "Bash", input: { command: "ls" }, approved: true }, { tool: "Bash", input: { command: "rm -rf x" }, approved: false }]), ["granted", "denied"]);
  });
});

test("planDeferredGrants: an approved call no rule can name is asked again, not widened", () => {
  assert.deepEqual(planDeferredGrants([{ tool: "Write", input: { file_path: "relative" }, approved: true }]), ["asked-again"]);
});

test("planDeferredGrants: an approved ExitPlanMode is cleared (it needs no rule), a denied one is denied", () => {
  assert.deepEqual(planDeferredGrants([{ tool: "ExitPlanMode", input: {}, approved: true }]), ["granted"]);
  assert.deepEqual(planDeferredGrants([{ tool: "ExitPlanMode", input: {}, approved: false }]), ["denied"]);
});
