import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToolKind, deriveOutcome, deriveSubject, parseMcpName } from "./claudeToolMapping.js";

test("tool names map to the kind of thing they do", () => {
  assert.equal(classifyToolKind("MultiEdit"), "edit");
  assert.equal(classifyToolKind("NotebookEdit"), "edit");
  assert.equal(classifyToolKind("WebSearch"), "web");
  assert.equal(classifyToolKind("WebFetch"), "web");
  assert.equal(classifyToolKind("mcp__linear__list_issues"), "mcp");
  assert.equal(classifyToolKind("Task"), "task");
});

test("an MCP name splits into server and tool, the tool keeping its own underscores", () => {
  assert.deepEqual(parseMcpName("mcp__linear__list_issues"), { server: "linear", tool: "list_issues" });
  assert.deepEqual(parseMcpName("mcp__plugin_x__a__b"), { server: "plugin_x", tool: "a__b" });
  assert.equal(parseMcpName("Bash"), undefined);
});

test("subjects are read from each tool's own input", () => {
  assert.deepEqual(deriveSubject("Bash", { command: "npm test" }), { kind: "shell", command: "npm test" });
  assert.deepEqual(deriveSubject("Read", { file_path: "/a.ts" }), { kind: "read", path: "/a.ts" });
  assert.deepEqual(deriveSubject("Read", { file_path: "/a.ts", offset: 10, limit: 5 }), { kind: "read", path: "/a.ts", range: { start: 10, end: 14 } });
  assert.deepEqual(deriveSubject("Read", { file_path: "/a.ts", offset: 10 }), { kind: "read", path: "/a.ts", range: { start: 10 } });
  assert.deepEqual(deriveSubject("Edit", { file_path: "/a.ts" }), { kind: "edit", path: "/a.ts" });
  assert.deepEqual(deriveSubject("MultiEdit", { file_path: "/a.ts" }), { kind: "edit", path: "/a.ts" });
  assert.deepEqual(deriveSubject("Write", { file_path: "/a.ts" }), { kind: "write", path: "/a.ts" });
  assert.deepEqual(deriveSubject("Grep", { pattern: "foo", path: "src" }), { kind: "search", mode: "content", pattern: "foo", path: "src" });
  assert.deepEqual(deriveSubject("Glob", { pattern: "**/*.ts" }), { kind: "search", mode: "files", pattern: "**/*.ts" });
  assert.deepEqual(deriveSubject("WebSearch", { query: "q" }), { kind: "web", mode: "search", query: "q" });
  assert.deepEqual(deriveSubject("WebFetch", { url: "https://x.dev" }), { kind: "web", mode: "fetch", url: "https://x.dev" });
  assert.deepEqual(deriveSubject("mcp__linear__list_issues", {}), { kind: "mcp", server: "linear", tool: "list_issues" });
  assert.deepEqual(deriveSubject("Task", { description: "explore" }), { kind: "task", label: "explore" });
  assert.deepEqual(deriveSubject("Brand New", {}), { kind: "other", label: "Brand New" });
});

test("a known tool with an unusable input has no subject rather than a wrong one", () => {
  assert.equal(deriveSubject("Bash", {}), undefined);
  assert.equal(deriveSubject("Read", { file_path: "" }), undefined);
});

test("Read: the file block becomes numbered code", () => {
  const outcome = deriveOutcome({ type: "text", file: { filePath: "/a.ts", content: "one\ntwo\n", startLine: 5, numLines: 2, totalLines: 40 } }, "", false);
  assert.deepEqual(outcome, { kind: "code", path: "/a.ts", lines: ["one", "two"], startLine: 5, totalLines: 40 });
});

test("Edit: the patch becomes a diff with added/removed counted from its lines", () => {
  const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" keep", "-old", "+new", "+extra"] };
  const outcome = deriveOutcome({ filePath: "/a.ts", oldString: "old", newString: "new", structuredPatch: [hunk] }, "", false);
  assert.deepEqual(outcome, { kind: "diff", path: "/a.ts", hunks: [hunk], added: 2, removed: 1 });
});

test("Write of a new file: an all-added hunk stands in for the missing patch", () => {
  const outcome = deriveOutcome({ type: "create", filePath: "/n.ts", content: "a\nb\n", structuredPatch: [], originalFile: null }, "", false);
  assert.deepEqual(outcome, {
    kind: "diff",
    path: "/n.ts",
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }],
    added: 2,
    removed: 0,
    created: true,
  });
});

test("Bash: stdout and stderr become terminal output, the exit code read from the error text", () => {
  assert.deepEqual(deriveOutcome({ stdout: "ok", stderr: "", interrupted: false }, "ok", false), { kind: "terminal", output: "ok" });
  assert.deepEqual(deriveOutcome({ stdout: "out", stderr: "boom" }, "Exit code 2\nboom", true), { kind: "terminal", output: "out\nboom", exitCode: 2 });
  assert.deepEqual(deriveOutcome("Error: Exit code 1", "Exit code 1\nnope", true, { name: "Bash", input: { command: "x" } }), {
    kind: "terminal",
    output: "Exit code 1\nnope",
    exitCode: 1,
  });
});

test("an exit code is never invented when the error text has none", () => {
  const outcome = deriveOutcome({ stdout: "", stderr: "killed" }, "killed", true);
  assert.deepEqual(outcome, { kind: "terminal", output: "killed" });
});

// Real payloads from a live `claude -p --output-format stream-json` run.
test("Glob: filenames become a file list", () => {
  const outcome = deriveOutcome({ filenames: ["a.txt"], durationMs: 18, numFiles: 1, truncated: false, totalMatches: 1, countIsComplete: true }, "a.txt", false);
  assert.deepEqual(outcome, { kind: "files", paths: ["a.txt"], total: 1 });
});

test("Grep (content mode): path:line:text lines become matches", () => {
  const outcome = deriveOutcome(
    { mode: "content", numFiles: 0, filenames: [], content: "a.txt:2:beta needle\nb.md:1:needle here", numLines: 2, totalLines: 2 },
    "",
    false,
  );
  assert.deepEqual(outcome, {
    kind: "matches",
    matches: [
      { path: "a.txt", line: 2, text: "beta needle" },
      { path: "b.md", line: 1, text: "needle here" },
    ],
    total: 2,
  });
});

test("Grep (files mode): file names become a file list", () => {
  const outcome = deriveOutcome({ mode: "files_with_matches", filenames: ["a.txt", "b.md"], numFiles: 2, totalFiles: 2 }, "", false);
  assert.deepEqual(outcome, { kind: "files", paths: ["a.txt", "b.md"], total: 2 });
});

test("WebSearch: result groups flatten into titled links", () => {
  const outcome = deriveOutcome(
    { query: "q", results: [{ tool_use_id: "s", content: [{ title: "One", url: "https://one.dev" }, { title: "Two", url: "https://two.dev" }] }, "a summary string"] },
    "",
    false,
  );
  assert.deepEqual(outcome, {
    kind: "links",
    results: [
      { title: "One", url: "https://one.dev" },
      { title: "Two", url: "https://two.dev" },
    ],
  });
});

test("MCP: the request comes from the paired call, the response from the flattened content", () => {
  const outcome = deriveOutcome([{ type: "text", text: "{}" }], "{}", false, { name: "mcp__linear__get", input: { id: "X-1" } });
  assert.deepEqual(outcome, { kind: "payload", request: JSON.stringify({ id: "X-1" }, null, 2), response: "{}" });
});

test("an unrecognized result shape has no outcome, so the plain content is what shows", () => {
  assert.equal(deriveOutcome({ something: "new" }, "text", false), undefined);
  assert.equal(deriveOutcome(undefined, "text", false), undefined);
});
