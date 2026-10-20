import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadGrantLabel, buildGrantRules, grantRuleFor, planDeferredGrants, resolveGrant } from "./grantRules.js";

// Touches the filesystem (symlink checks), hence the io tier.

/** Plans as the session does: every call carries the rule stored with its card. */
const plan = (calls: Parameters<typeof planDeferredGrants>[0], options?: Parameters<typeof planDeferredGrants>[1]) =>
  planDeferredGrants(
    calls.map((call) => ({ stored: grantRuleFor(call), ...call })),
    options,
  );

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

test("a path no single rule can name safely gets the tool-wide edit rule, flagged broad (never a narrow rule that would cover a subtree)", () => {
  withDir((dir) => {
    const unsafe = [
      `${dir}/x/..`, // the parent: a whole subtree
      `${dir}/.`,
      `${dir}/`,
      `${dir}//x`,
      `${dir}/a/../b`,
      "relative/out.txt",
      `${dir}/*.txt`,
      `${dir}/a?b`,
      `${dir}/app/[id]/page.tsx`,
      `${dir}/app/(auth)/login.tsx`,
      `${dir}/{a,b}`,
      `${dir}/a,b`,
    ];
    for (const file_path of unsafe) {
      assert.deepEqual(grantRuleFor({ tool: "Write", input: { file_path } }), { rule: "Write", broad: true }, file_path);
    }
    assert.deepEqual(grantRuleFor({ tool: "Edit", input: { file_path: `${dir}/app/[id]/page.tsx` } }), { rule: "Edit", broad: true });
    assert.deepEqual(grantRuleFor({ tool: "MultiEdit", input: { file_path: "rel" } }), { rule: "Edit", broad: true });
    assert.equal(grantRuleFor({ tool: "Edit", input: {} }), undefined, "no path at all: nothing to grant");
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: 3 } }), undefined);
  });
});

test("a path through a symlinked directory, or that is itself a symlink, is broad; a not-yet-existing file in a real directory is narrow", () => {
  withDir((dir) => {
    mkdirSync(`${dir}/real`);
    symlinkSync(`${dir}/real`, `${dir}/link`);
    writeFileSync(`${dir}/real/f.txt`, "x");
    symlinkSync(`${dir}/real/f.txt`, `${dir}/real/alias.txt`);
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/link/f.txt` } })?.broad, true, "symlinked directory");
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/alias.txt` } })?.broad, true, "symlink file");
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/f.txt` } })?.broad, false);
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/real/new.txt` } })?.broad, false);
    assert.equal(grantRuleFor({ tool: "Write", input: { file_path: `${dir}/missing-dir/new.txt` } })?.broad, false, "an unresolvable parent is not a symlink");
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

test("buildGrantRules: dedupes, skips ExitPlanMode", () => {
  withDir((dir) => {
    assert.deepEqual(
      buildGrantRules([
        { tool: "Write", input: { file_path: `${dir}/a` } },
        { tool: "Write", input: { file_path: `${dir}/a` } },
        { tool: "Write", input: { file_path: `${dir}/b` } },
        { tool: "Write", input: { file_path: "relative" } },
        { tool: "ExitPlanMode", input: {} },
      ]),
      [`Edit(/${dir}/a)`, `Edit(/${dir}/b)`, "Write"],
    );
  });
});

test("planDeferredGrants: a broad grant needs EVERY call of that tool approved; approve `ls | head` + deny `rm -rf` grants nothing for Bash", () => {
  const ls = { tool: "Bash", input: { command: "ls | head" } };
  const rm = { tool: "Bash", input: { command: "rm -rf ~/x" } };
  assert.deepEqual(plan([{ ...ls, approved: true }, { ...rm, approved: false }]), ["asked-again", "denied"]);
  assert.deepEqual(plan([{ ...ls, approved: true }, { ...rm, approved: true }]), ["granted", "granted"]);
});

test("planDeferredGrants: the same rule holds for MCP and WebFetch, and a narrow grant is unaffected by a refusal of the same tool", () => {
  withDir((dir) => {
    const mcp = { tool: "mcp__s__t", input: {} };
    assert.deepEqual(plan([{ ...mcp, approved: true }, { ...mcp, input: { x: 1 }, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(plan([{ tool: "Write", input: { file_path: `${dir}/a` }, approved: true }, { tool: "Write", input: { file_path: `${dir}/b` }, approved: false }]), ["granted", "denied"]);
    assert.deepEqual(plan([{ tool: "Bash", input: { command: "ls" }, approved: true }, { tool: "Bash", input: { command: "rm -rf x" }, approved: false }]), ["granted", "denied"]);
  });
});

test("planDeferredGrants: approving /repo/app/[id]/page.tsx is granted tool-wide when nothing of the edit tools was refused, so it converges", () => {
  withDir((dir) => {
    const page = { tool: "Edit", input: { file_path: `${dir}/app/[id]/page.tsx` } };
    assert.deepEqual(plan([{ ...page, approved: true }]), ["granted"]);
    assert.deepEqual(buildGrantRules([page]), ["Edit"]);
  });
});

test("planDeferredGrants: with a refused sibling in the edit family, the broad edit grant is withheld (Write, Edit and MultiEdit count as one)", () => {
  withDir((dir) => {
    const page = { tool: "Write", input: { file_path: `${dir}/app/[id]/page.tsx` } };
    assert.deepEqual(plan([{ ...page, approved: true }, { tool: "Write", input: { file_path: `${dir}/b.ts` }, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(plan([{ ...page, approved: true }, { tool: "Edit", input: { file_path: `${dir}/b.ts` }, approved: false }]), ["asked-again", "denied"]);
  });
});

test("planDeferredGrants: a narrow rule is not given when a refused call names the same target (Edit a.ts approved, Write a.ts denied)", () => {
  withDir((dir) => {
    const a = `${dir}/a.ts`;
    assert.deepEqual(plan([{ tool: "Edit", input: { file_path: a }, approved: true }, { tool: "Write", input: { file_path: a }, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(plan([{ tool: "Bash", input: { command: "ls" }, approved: true }, { tool: "Bash", input: { command: "ls" }, approved: false }]), ["asked-again", "denied"]);
  });
});

test("planDeferredGrants: an approved call with nothing to grant (no path) is asked again", () => {
  assert.deepEqual(plan([{ tool: "Write", input: {}, approved: true }]), ["asked-again"]);
});

test("planDeferredGrants: an approved ExitPlanMode is cleared (it needs no rule), a denied one is denied", () => {
  assert.deepEqual(plan([{ tool: "ExitPlanMode", input: {}, approved: true }]), ["granted"]);
  assert.deepEqual(plan([{ tool: "ExitPlanMode", input: {}, approved: false }]), ["denied"]);
});

test("NotebookEdit belongs to the file-edit group: refusing one blocks the broad edit grant, and the other way round", () => {
  withDir((dir) => {
    const page = { tool: "Write", input: { file_path: `${dir}/app/[id]/page.tsx` } };
    const nb = { tool: "NotebookEdit", input: { notebook_path: `${dir}/n.ipynb` } };
    assert.deepEqual(plan([{ ...page, approved: true }, { ...nb, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(plan([{ ...nb, approved: true }, { ...page, approved: false }]), ["asked-again", "denied"]);
    assert.deepEqual(plan([{ ...nb, approved: true }]), ["granted"]);
  });
});

test("a call still waiting for an answer (queued behind this card) blocks a broad grant and a narrow one on the same target", () => {
  withDir((dir) => {
    const page = { tool: "Write", input: { file_path: `${dir}/app/[id]/page.tsx` }, approved: true };
    assert.deepEqual(plan([page], { waiting: [{ tool: "Write", input: { file_path: `${dir}/other.ts` } }] }), ["asked-again"]);
    assert.deepEqual(plan([{ tool: "Bash", input: { command: "ls | head" }, approved: true }], { waiting: [{ tool: "Bash", input: { command: "rm -rf x" } }] }), ["asked-again"]);
    const narrow = { tool: "Write", input: { file_path: `${dir}/a.ts` }, approved: true };
    assert.deepEqual(plan([narrow], { waiting: [{ tool: "Write", input: { file_path: `${dir}/b.ts` } }] }), ["granted"], "a different target is unaffected");
    assert.deepEqual(plan([narrow], { waiting: [{ tool: "Edit", input: { file_path: `${dir}/a.ts` } }] }), ["asked-again"]);
  });
});

test("a refused call that names the same file another way blocks the narrow rule (relative to the cwd, through a symlink)", () => {
  withDir((dir) => {
    mkdirSync(`${dir}/repo`);
    symlinkSync(`${dir}/repo`, `${dir}/alias`);
    const approved = { tool: "Edit", input: { file_path: `${dir}/repo/a.ts` }, approved: true };
    assert.deepEqual(plan([approved, { tool: "Write", input: { file_path: "a.ts" }, approved: false }], { cwd: `${dir}/repo` }), ["asked-again", "denied"], "relative to the session's folder");
    assert.deepEqual(plan([approved, { tool: "Write", input: { file_path: `${dir}/alias/a.ts` }, approved: false }], { cwd: dir }), ["asked-again", "denied"], "through a symlinked directory");
    assert.deepEqual(plan([approved, { tool: "Write", input: { file_path: `${dir}/repo/b.ts` }, approved: false }], { cwd: dir }), ["granted", "denied"]);
  });
});

test("resolveGrant: the rule stored with the card wins; a recalculation that disagrees can only narrow it, never widen it", () => {
  withDir((dir) => {
    const call = { tool: "Write", input: { file_path: `${dir}/real/f.txt` } };
    mkdirSync(`${dir}/real`);
    const narrow = { rule: `Edit(/${dir}/real/f.txt)`, broad: false };
    assert.deepEqual(resolveGrant(narrow, call), narrow);
    // The folder became a symlink after the card was shown: the stored narrow
    // rule no longer names what it did, and a fresh broad one was never shown.
    rmSync(`${dir}/real`, { recursive: true });
    mkdirSync(`${dir}/elsewhere`);
    symlinkSync(`${dir}/elsewhere`, `${dir}/real`);
    assert.equal(resolveGrant(narrow, call), undefined);
    // A broad rule stored and shown stays broad while the recalculation agrees, and narrows when it can.
    assert.deepEqual(resolveGrant({ rule: "Write", broad: true }, call), { rule: "Write", broad: true });
    assert.deepEqual(resolveGrant({ rule: "Write", broad: true }, { tool: "Write", input: { file_path: `${dir}/elsewhere/g.txt` } })?.broad, false);
    // No stored rule (a card from before rules were stored): never broad.
    assert.equal(resolveGrant(undefined, { tool: "Bash", input: { command: "ls | head" } }), undefined);
    assert.deepEqual(resolveGrant(undefined, { tool: "Bash", input: { command: "ls" } }), { rule: "Bash(ls)", broad: false });
  });
});

test("broadGrantLabel: the whole edit family is named as file-edit, other tools by name", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.equal(broadGrantLabel(tool), "file-edit");
  assert.equal(broadGrantLabel("Bash"), "Bash");
  assert.equal(broadGrantLabel("mcp__s__t"), "mcp__s__t");
});
