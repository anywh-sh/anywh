import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Assertions about the codebase's shape that `import-x/no-restricted-paths`
// (relay/eslint.config.js) can't express, because they aren't about one
// file importing another — they're about a string literal showing up
// somewhere it shouldn't. `docs/invariants.md` lists the boundary rules
// eslint *does* cover; this file is where the ones it can't land, one test
// per assertion, so a new one added later doesn't have to invent its own
// file-walking helper.

const SRC_DIR = join(import.meta.dirname, ".");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// `ExecPlan`'s variant tags (runtimes/types.ts) — not `"custom"`, which is
// too generic a word to grep for without false positives elsewhere in the
// codebase.
const EXEC_PLAN_KIND_LITERALS = ["spawnPerTurn", "jsonRpcDaemon"];

test("no file outside runtimes/ constructs or branches on an ExecPlan's `kind`", () => {
  // This is the rule that tests the design of runtimes/types.ts's `exec`
  // union more than the shape of the type itself: if session/ (or
  // anything else) ever needs to know whether it's driving a
  // spawn-per-turn CLI or a JSON-RPC daemon, the abstraction failed and
  // the second agent became a graft onto session/ instead of a def.
  // Nothing outside runtimes/ consumes `exec` yet (that starts in a later
  // phase), so this test is a tripwire for the day it does, not a report
  // on today's code.
  const offenders: string[] = [];
  for (const file of collectTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file);
    if (relPath.startsWith(`runtimes${sep}`) || file === import.meta.filename) continue;
    const content = readFileSync(file, "utf8");
    for (const literal of EXEC_PLAN_KIND_LITERALS) {
      if (content.includes(`"${literal}"`)) offenders.push(`${relPath} references "${literal}"`);
    }
  }
  assert.deepEqual(offenders, []);
});
