import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeModelCatalog } from "./modelCatalog.js";
import type { AgentRuntimeDef, Capabilities, ModelCatalog, ModelSource, PermissionMode } from "../types.js";

// Boundary tier (.anywh/skills/tests/SKILL.md): a real child process, no
// fake — same shape as runtimeAuth.io.test.ts. The "CLI" is a shell script
// this test writes; what matters is what `probeModelCatalog` hands it on
// argv and stdin, and when it decides the answer is in.

const ALL_NONE: Capabilities = {
  presentChoice: "none",
  approvalPrompt: "none",
  rewindTurn: "none",
  replayHistory: "none",
  backgroundJobs: "none",
  thinking: "none",
  contextUsage: "none",
};

const DEFAULT_MODE: PermissionMode<undefined> = { id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false };

function defWith(bin: string, models: ModelSource): AgentRuntimeDef {
  return {
    identity: { id: "fixture", bin, env: { strip: ["FIXTURE_API_KEY"] }, projectInstructionsFile: "AGENTS.md" },
    capabilities: ALL_NONE,
    continuity: { kind: "relay-transcript" },
    models,
    auth: { kind: "none" },
    permissions: { defaultModeId: "default", modesFor: () => [DEFAULT_MODE] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: {
      kind: "spawnPerTurn",
      promptDelivery: "argv",
      buildArgs: () => [],
      mapStdoutLine: () => [],
      interrupt: { signal: "SIGINT", expectsCleanExit: true },
    },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

function fakeCli(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "anywh-model-probe-")), "fake-cli");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Catalog out of "one option per stdout line" — enough to see what the
 * CLI printed. `undefined` until a line reading "END" has arrived. */
function linesUntilEnd(stdout: string): ModelCatalog | undefined {
  const lines = stdout.split("\n");
  if (!lines.includes("END")) return undefined;
  return { options: lines.filter((line) => line && line !== "END").map((line) => ({ id: line, label: line })) };
}

test("probeModelCatalog: hands the def's args and stdin to the def's binary", async () => {
  const bin = fakeCli('echo "$*"; read line; echo "$line"; echo END');
  const def = defWith(bin, { kind: "cli-probe", args: ["list", "--json"], stdin: "hello\n", parse: linesUntilEnd });
  const catalog = await probeModelCatalog(def, undefined, tmpdir());
  assert.deepEqual(
    catalog?.options.map((option) => option.id),
    ["list --json", "hello"],
  );
});

test("probeModelCatalog: holds stdin open until parse recognizes the answer, then ends the process itself", async () => {
  // Codex's app-server shape: it exits on stdin EOF *before* answering, so
  // a probe that closed stdin after writing would never see the reply.
  // This script answers only after a delay and would then block forever on
  // a second `read` — the probe has to both wait for it and kill it.
  const bin = fakeCli('read line; if [ -z "$line" ]; then exit 1; fi; sleep 0.2; echo "$line"; echo END; read never');
  const def = defWith(bin, { kind: "cli-probe", args: [], stdin: "gpt-fake\n", parse: linesUntilEnd });
  const start = Date.now();
  const catalog = await probeModelCatalog(def, undefined, tmpdir());
  assert.deepEqual(catalog?.options.map((option) => option.id), ["gpt-fake"]);
  assert.ok(Date.now() - start < 5000, "resolved on the answer, not on the probe timeout");
});

test("probeModelCatalog: a CLI that exits without a recognizable answer yields undefined, not a throw", async () => {
  const bin = fakeCli("echo garbage; exit 3");
  const def = defWith(bin, { kind: "cli-probe", args: [], parse: linesUntilEnd });
  assert.equal(await probeModelCatalog(def, undefined, tmpdir()), undefined);
});

test("probeModelCatalog: an empty catalog counts as no catalog", async () => {
  const bin = fakeCli("echo END");
  const def = defWith(bin, { kind: "cli-probe", args: [], parse: linesUntilEnd });
  assert.equal(await probeModelCatalog(def, undefined, tmpdir()), undefined);
});

test("probeModelCatalog: a binary that doesn't exist yields undefined", async () => {
  const def = defWith("/nonexistent/anywh-fake-cli", { kind: "cli-probe", args: [], parse: linesUntilEnd });
  assert.equal(await probeModelCatalog(def, undefined, tmpdir()), undefined);
});

test("probeModelCatalog: static returns the def's own catalog, session-rpc has nothing to spawn", async () => {
  const catalog: ModelCatalog = { options: [{ id: "m", label: "M" }], defaultId: "m" };
  assert.deepEqual(await probeModelCatalog(defWith("unused", { kind: "static", catalog }), undefined, tmpdir()), catalog);
  assert.equal(await probeModelCatalog(defWith("unused", { kind: "session-rpc" }), undefined, tmpdir()), undefined);
});

test("probeModelCatalog: strips the def's credential vars from the probe's env", async () => {
  process.env.FIXTURE_API_KEY = "secret";
  try {
    const bin = fakeCli('echo "key=${FIXTURE_API_KEY:-unset}"; echo END');
    const def = defWith(bin, { kind: "cli-probe", args: [], parse: linesUntilEnd });
    const catalog = await probeModelCatalog(def, undefined, tmpdir());
    assert.deepEqual(catalog?.options.map((option) => option.id), ["key=unset"]);
  } finally {
    delete process.env.FIXTURE_API_KEY;
  }
});
