import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuickPrompt } from "./quickPrompt.js";
import type { AgentRuntimeDef, QuickPromptContext } from "../types.js";

// Same reasoning as detection.io.test.ts's own helper: awaits the caller
// before cleanup, since every test here spawns a real child process against
// a script inside `dir`.
async function withTmpDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-quickprompt-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixtureDef(bin: string, kind: "cli" | "none" = "cli"): AgentRuntimeDef {
  return {
    identity: { id: "fixture", bin, env: { strip: [] }, projectInstructionsFile: "AGENTS.md" },
    capabilities: {
      presentChoice: "none",
      approvalPrompt: "none",
      rewindTurn: "none",
      replayHistory: "none",
      backgroundJobs: "none",
      thinking: "none",
      contextUsage: "none",
    },
    continuity: { kind: "relay-transcript" },
    models: { kind: "static", options: [] },
    auth: { kind: "none" },
    permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false }] },
    bridges: [],
    quickPrompt:
      kind === "none"
        ? { kind: "none" }
        : { kind: "cli", buildArgs: (ctx: QuickPromptContext) => ["--system", ctx.systemPrompt, "--user", ctx.userPrompt], extractReply: (stdout) => stdout.trim() || undefined },
    exec: { kind: "spawnPerTurn", promptDelivery: "argv", buildArgs: () => [], mapStdoutLine: () => [], interrupt: { signal: "SIGINT", expectsCleanExit: true } },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

test("runQuickPrompt: undefined without spawning anything when quickPrompt.kind is none", async () => {
  const result = await runQuickPrompt(fixtureDef("definitely-not-a-real-binary-xyz-anywh", "none"), undefined, "/tmp", "system", "user");
  assert.equal(result, undefined);
});

test("runQuickPrompt: spawns the def's own bin with buildArgs' argv, in the given cwd, and returns stdout/exitCode", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeScript(dir, "fake-agent", 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));');
    const result = await runQuickPrompt(fixtureDef(bin), undefined, dir, "You title chats.", "fix the login bug");
    assert.equal(result?.exitCode, 0);
    assert.deepEqual(JSON.parse(result?.stdout ?? "{}"), { argv: ["--system", "You title chats.", "--user", "fix the login bug"], cwd: dir });
  });
});

// The real regression this guards: confirmed live (see quickPrompt.ts's own
// doc comment) that `codex exec` blocks forever on a still-open, never-
// written stdin pipe — Node's default `spawn` stdio leaves stdin exactly
// that way unless told otherwise. This fixture reproduces the shape of that
// hang generically (not Codex-specific): a script that waits for stdin's
// own "end" event before it ever writes to stdout or exits. If
// `runQuickPrompt` ever stopped passing `stdio: ["ignore", ...]`, this test
// would time out instead of failing cleanly — still a regression, just a
// slower one to notice, which is exactly why it needs to be pinned down.
test("runQuickPrompt: stdin is ignored, not left open — a child waiting for stdin EOF must not hang", async () => {
  await withTmpDir(async (dir) => {
    const bin = writeScript(
      dir,
      "fake-agent",
      "process.stdin.on('end', () => { process.stdout.write('done'); process.exit(0); }); process.stdin.resume();",
    );
    const result = await runQuickPrompt(fixtureDef(bin), undefined, dir, "system", "user");
    assert.equal(result?.exitCode, 0);
    assert.equal(result?.stdout, "done");
  });
});
