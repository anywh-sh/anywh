import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitStatus } from "./gitStatus.js";

// Unit tests for the pure half of `GET /git/status`: turning git's
// porcelain v2 output into the two numbers the status bar renders. The
// spawn half (a real repo, a real `git` child process) is covered for real
// in relay/tests/gitStatus.test.ts.

test("reads the branch name off the header and counts nothing in a clean tree", () => {
  const parsed = parseGitStatus(["# branch.oid 8a6732ad", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0", ""].join("\n"));
  assert.deepEqual(parsed, { branch: "main", detached: false, changes: 0 });
});

test("counts tracked changes, untracked files and unmerged paths alike", () => {
  // What the status bar promises is "how many entries `git status` would
  // show you", not "how many tracked files differ from HEAD" — a new file
  // nobody has added yet is a change the user can see in the panel.
  const parsed = parseGitStatus(
    [
      "# branch.oid 8a6732ad",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 aaa bbb client/src/App.tsx",
      "1 M. N... 100644 100644 100644 ccc ddd relay/src/server.ts",
      "u UU N... 100644 100644 100644 100644 eee fff ggg relay/src/theme.ts",
      "? notes.txt",
      "",
    ].join("\n"),
  );
  assert.equal(parsed.changes, 4);
});

test("counts a rename as the single change it is", () => {
  // A `2 ` entry carries the original path after a tab on the same line.
  // Counting lines that look like paths instead of entries would double it.
  const parsed = parseGitStatus(
    ["# branch.head main", "2 R. N... 100644 100644 100644 aaa bbb R100 client/src/lib/appVersion.ts\tclient/src/lib/version.ts", ""].join("\n"),
  );
  assert.equal(parsed.changes, 1);
});

test("falls back to the short commit on a detached HEAD", () => {
  // `git status` writes the literal string `(detached)` where a branch name
  // would go — rendering that verbatim would be a lie about the branch.
  const parsed = parseGitStatus(["# branch.oid 8a6732adf2c1b9e4d0a7c6b5a4938271e0f1a2b3", "# branch.head (detached)", "? notes.txt", ""].join("\n"));
  assert.deepEqual(parsed, { branch: "8a6732a", detached: true, changes: 1 });
});

test("survives a repository without a first commit", () => {
  // `git init` then nothing: the branch exists, the oid doesn't.
  const parsed = parseGitStatus(["# branch.oid (initial)", "# branch.head main", "? README.md", ""].join("\n"));
  assert.deepEqual(parsed, { branch: "main", detached: false, changes: 1 });
});

test("keeps a slashed branch name intact", () => {
  // `redesign/f8-status-bar` is the common case — nothing about the name is
  // a delimiter for the header line, only the key in front of it is.
  assert.equal(parseGitStatus("# branch.head redesign/f8-status-bar\n").branch, "redesign/f8-status-bar");
});
