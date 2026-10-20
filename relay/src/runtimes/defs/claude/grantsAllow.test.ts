import { test } from "node:test";
import assert from "node:assert/strict";
import { grantsAllow } from "./grantRules.js";

const cwd = "/work";

test("a grant that names one call allows that call and nothing else", () => {
  const bash = [{ tool: "Bash", input: { command: "npm test" }, rule: "Bash(npm test)" }];
  assert.equal(grantsAllow(bash, { tool: "Bash", input: { command: "npm test" } }, cwd), true);
  assert.equal(grantsAllow(bash, { tool: "Bash", input: { command: "rm -rf /" } }, cwd), false);
  const edit = [{ tool: "Write", input: { file_path: "/work/a.txt" }, rule: "Edit(//work/a.txt)" }];
  assert.equal(grantsAllow(edit, { tool: "Write", input: { file_path: "/work/a.txt", content: "x" } }, cwd), true);
  assert.equal(grantsAllow(edit, { tool: "Edit", input: { file_path: "a.txt" } }, cwd), true, "the same file by another tool or spelling");
  assert.equal(grantsAllow(edit, { tool: "Write", input: { file_path: "/work/b.txt" } }, cwd), false);
  assert.equal(grantsAllow(edit, { tool: "Bash", input: { command: "echo > /work/a.txt" } }, cwd), false);
});

test("a grant that names a whole tool allows every call of it, and the edit tools together", () => {
  const edit = [{ tool: "Write", input: { file_path: "/work/a ( 1).txt" }, rule: "Edit" }];
  assert.equal(grantsAllow(edit, { tool: "Edit", input: { file_path: "/work/z" } }, cwd), true);
  assert.equal(grantsAllow(edit, { tool: "Bash", input: { command: "ls" } }, cwd), false);
  assert.equal(grantsAllow([{ tool: "mcp__srv__do", input: {}, rule: "mcp__srv__do" }], { tool: "mcp__srv__do", input: { a: 1 } }, cwd), true);
});

test("nothing is allowed without a grant; approving the plan allows leaving plan mode", () => {
  assert.equal(grantsAllow([], { tool: "Bash", input: { command: "ls" } }, cwd), false);
  assert.equal(grantsAllow([{ tool: "ExitPlanMode", input: {} }], { tool: "ExitPlanMode", input: { plan: "p" } }, cwd), true);
  assert.equal(grantsAllow([{ tool: "ExitPlanMode", input: {} }], { tool: "Bash", input: { command: "ls" } }, cwd), false);
});
