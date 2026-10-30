import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSelectableAgents, type SelectableAgent, type SelectableAgentsTargets } from "./selectableAgents.js";
import type { AgentRuntimeDef, Capabilities, ModelCatalog } from "./types.js";

const ALL_NONE: Capabilities = {
  presentChoice: "none",
  approvalPrompt: "none",
  rewindTurn: "none",
  replayHistory: "none",
  backgroundJobs: "none",
  thinking: "none",
  contextUsage: "none",
};

async function withTmpDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-selectable-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A real executable that answers `--version`, standing in for an
 * installed CLI — detection only checks the exit code and stdout. */
function writeVersionScript(dir: string, name: string, version: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${version}\n`)});\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixtureDef(id: string, bin: string, catalog: ModelCatalog): AgentRuntimeDef {
  return {
    identity: { id, bin, env: { strip: [] }, projectInstructionsFile: "AGENTS.md" },
    capabilities: { ...ALL_NONE, thinking: "native" },
    continuity: { kind: "relay-transcript" },
    models: { kind: "static", catalog },
    auth: { kind: "none" },
    permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "mode.default", settings: undefined, pausesForApproval: false }] },
    bridges: [],
    quickPrompt: { kind: "none" },
    exec: { kind: "spawnPerTurn", promptDelivery: "argv", buildArgs: () => [], mapStdoutLine: () => [], interrupt: { signal: "SIGINT", expectsCleanExit: true } },
    portability: { authoredPaths: [".fixture/skills"], mcp: { kind: "none" } },
  };
}

interface Published {
  selectable?: readonly SelectableAgent[];
  roomRuntimes?: readonly string[];
  catalogs: Record<string, ModelCatalog>;
}

function recordingTargets(defs: readonly AgentRuntimeDef[], dir: string, overrides: Partial<SelectableAgentsTargets> = {}): { targets: SelectableAgentsTargets; published: Published } {
  const published: Published = { catalogs: {} };
  const targets: SelectableAgentsTargets = {
    defs,
    selectableIds: defs.map((def) => def.identity.id),
    roomRuntimeIds: defs.map((def) => def.identity.id),
    homeOverride: dir,
    cwd: dir,
    publishSelectable: (agents) => (published.selectable = agents),
    publishRoomRuntimes: (ids) => (published.roomRuntimes = ids),
    publishModelCatalog: (agentId, catalog) => (published.catalogs[agentId] = catalog),
    ...overrides,
  };
  return { targets, published };
}

const CATALOG: ModelCatalog = { options: [{ id: "m1", label: "Model 1" }], defaultId: "m1" };

test("refreshSelectableAgents publishes only installed agents, with their parsed version, and resolves with every detection", async () => {
  await withTmpDir(async (dir) => {
    const present = fixtureDef("present", writeVersionScript(dir, "present-cli", "present-cli 1.2.3 (fixture)"), CATALOG);
    const missing = fixtureDef("missing", join(dir, "no-such-cli"), CATALOG);
    const { targets, published } = recordingTargets([present, missing], dir);

    const detections = await refreshSelectableAgents(targets);

    assert.deepEqual(
      detections.map((detection) => [detection.id, detection.installed]),
      [
        ["present", true],
        ["missing", false],
      ],
    );
    assert.deepEqual(published.selectable, [{ id: "present", capabilities: present.capabilities, version: "1.2.3" }]);
    assert.deepEqual(published.roomRuntimes, ["present"]);
  });
});

test("refreshSelectableAgents: an installed agent outside selectableIds is neither offered nor run in rooms", async () => {
  await withTmpDir(async (dir) => {
    const offered = fixtureDef("offered", writeVersionScript(dir, "offered-cli", "1.0.0"), CATALOG);
    const hidden = fixtureDef("hidden", writeVersionScript(dir, "hidden-cli", "2.0.0"), CATALOG);
    const { targets, published } = recordingTargets([offered, hidden], dir, { selectableIds: ["offered"], roomRuntimeIds: ["offered", "hidden"] });

    await refreshSelectableAgents(targets);

    assert.deepEqual(
      published.selectable?.map((agent) => agent.id),
      ["offered"],
    );
    assert.deepEqual(published.roomRuntimes, ["offered"]);
  });
});

test("refreshSelectableAgents: room runtimes are the selectable agents a room can run, nothing more", async () => {
  await withTmpDir(async (dir) => {
    const both = fixtureDef("both", writeVersionScript(dir, "both-cli", "1.0.0"), CATALOG);
    const chatOnly = fixtureDef("chat-only", writeVersionScript(dir, "chat-cli", "1.0.0"), CATALOG);
    const { targets, published } = recordingTargets([both, chatOnly], dir, { roomRuntimeIds: ["both"] });

    await refreshSelectableAgents(targets);

    assert.deepEqual(
      published.selectable?.map((agent) => agent.id),
      ["both", "chat-only"],
    );
    assert.deepEqual(published.roomRuntimes, ["both"]);
  });
});

test("refreshSelectableAgents probes the model catalog of each selectable agent, never of a missing one", async () => {
  await withTmpDir(async (dir) => {
    const otherCatalog: ModelCatalog = { options: [{ id: "x", label: "X" }] };
    const present = fixtureDef("present", writeVersionScript(dir, "present-cli", "1.0.0"), CATALOG);
    const missing = fixtureDef("missing", join(dir, "no-such-cli"), otherCatalog);
    const { targets, published } = recordingTargets([present, missing], dir);

    await refreshSelectableAgents(targets);
    // The probe runs after the promise resolves (a slow CLI must not hold
    // the detection back); a static catalog lands on the next tick.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(published.catalogs, { present: CATALOG });
  });
});

test("refreshSelectableAgents: an agent whose catalog is already known is not probed again", async () => {
  await withTmpDir(async (dir) => {
    const known = fixtureDef("known", writeVersionScript(dir, "known-cli", "1.0.0"), CATALOG);
    const fresh = fixtureDef("fresh", writeVersionScript(dir, "fresh-cli", "1.0.0"), CATALOG);
    const { targets, published } = recordingTargets([known, fresh], dir, { hasModelCatalog: (agentId) => agentId === "known" });

    await refreshSelectableAgents(targets);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(Object.keys(published.catalogs), ["fresh"]);
  });
});
