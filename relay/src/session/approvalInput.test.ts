import { test } from "node:test";
import assert from "node:assert/strict";
import { compactToolInput } from "./approvalInput.js";

test("a large content or edit string is cut with a marker saying how much went", () => {
  const out = compactToolInput({ file_path: "/tmp/a", content: "x".repeat(10_000) }) as { file_path: string; content: string };
  assert.equal(out.file_path, "/tmp/a");
  assert.equal(out.content.length, 4096 + "…[truncated 5904 more characters]".length);
  assert.ok(out.content.endsWith("…[truncated 5904 more characters]"));
});

test("the fields a grant is derived from are never shortened, however long", () => {
  const command = `echo ${"a".repeat(9_000)}`;
  const filePath = `/tmp/${"d/".repeat(3_000)}f`;
  const out = compactToolInput({ command, file_path: filePath, notebook_path: filePath }) as Record<string, string>;
  assert.equal(out.command, command);
  assert.equal(out.file_path, filePath);
  assert.equal(out.notebook_path, filePath);
});

test("small inputs come back equal; a big non-string field becomes a marker", () => {
  assert.deepEqual(compactToolInput({ file_path: "/tmp/a", content: "hi", flag: true, n: 3 }), { file_path: "/tmp/a", content: "hi", flag: true, n: 3 });
  const out = compactToolInput({ edits: Array.from({ length: 2_000 }, (_, i) => ({ old_string: `o${i}`, new_string: `n${i}` })) }) as { edits: string };
  assert.match(out.edits, /^\[omitted: \d+ characters\]$/);
});

test("non-object input passes through, a long bare string is cut", () => {
  assert.equal(compactToolInput(undefined), undefined);
  assert.deepEqual(compactToolInput([1, 2]), [1, 2]);
  assert.match(compactToolInput("y".repeat(5_000)) as string, /truncated 904 more characters\]$/);
});
