import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

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

// True only for `import.meta.url` passed as the first argument of a direct
// `resolveShipped(...)` call (src/host/paths.ts), whose SEA branch never
// reads it.
function isResolveShippedUrlArgument(meta: ts.MetaProperty): boolean {
  const access = meta.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== "url") return false;
  const call = access.parent;
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "resolveShipped" && call.arguments[0] === access;
}

test("import.meta is only read as resolveShipped's first argument", () => {
  // The macOS build bundles the relay into one CommonJS file for a Node SEA
  // binary (sea-build/build.mjs), where `import.meta` is an empty object: a
  // module that resolves a path from `import.meta.url` (or reads
  // `import.meta.dirname`/`filename`) at load time throws before the relay
  // binds its port — how 0.2.0 shipped a macOS relay that never started.
  // `resolveShipped` checks `isSea()` before it touches the URL. Parsed, not
  // grepped, so comments that mention it (host/paths.ts) don't count.
  const offenders: string[] = [];
  for (const file of collectTsFiles(SRC_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const relPath = relative(SRC_DIR, file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && !isResolveShippedUrlArgument(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push(`${relPath}:${line + 1} ${node.parent.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});
