import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRefresher, refreshSelectableAgents, type SelectableAgent, type SelectableAgentsTargets } from "./selectableAgents.js";
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

/** Answers `--version` until `hangFlag` exists, then never answers — a CLI
 * too slow for detection's 3 s timeout. */
function writeHangingScript(dir: string, name: string, hangFlag: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node\nif (require("node:fs").existsSync(${JSON.stringify(hangFlag)})) setTimeout(() => {}, 10_000);\nelse process.stdout.write("1.0.0\\n");\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("createAgentRefresher: an installed agent whose --version times out keeps its place; one that is gone is dropped", async () => {
  await withTmpDir(async (dir) => {
    const hangFlag = join(dir, "hang");
    const bin = writeHangingScript(dir, "slow-cli.cjs", hangFlag);
    const slow = fixtureDef("slow", bin, CATALOG);
    const { targets, published } = recordingTargets([slow], dir);
    const refresh = createAgentRefresher(targets);

    assert.equal((await refresh())[0].installed, true);

    writeFileSync(hangFlag, "");
    const [kept] = await refresh();
    assert.equal(kept.installed, true, "a timeout is not proof the CLI is gone");
    assert.equal(kept.version, "1.0.0");
    assert.deepEqual(published.selectable?.map((agent) => agent.id), ["slow"]);
    assert.deepEqual(published.roomRuntimes, ["slow"]);

    rmSync(bin);
    assert.equal((await refresh())[0].installed, false);
    assert.deepEqual(published.selectable, []);
  });
});

test("refreshSelectableAgents: a CLI that times out with no earlier detection is not installed", async () => {
  await withTmpDir(async (dir) => {
    const hangFlag = join(dir, "hang");
    writeFileSync(hangFlag, "");
    const slow = fixtureDef("slow", writeHangingScript(dir, "slow-cli.cjs", hangFlag), CATALOG);
    const { targets, published } = recordingTargets([slow], dir);

    const [detection] = await refreshSelectableAgents(targets);
    assert.equal(detection.installed, false);
    assert.equal(detection.timedOut, true);
    assert.deepEqual(published.selectable, []);
  });
});

/** Logs every invocation's first arg to `log`, then answers `--version`
 * after `delayMs`, and a `models` probe with one model after `delayMs`. */
function writeCountingScript(dir: string, name: string, log: string, delayMs: number): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv[2] + "\\n");`,
      `setTimeout(() => process.stdout.write(process.argv[2] === "--version" ? "1.0.0\\n" : "MODELS\\n"), ${delayMs});`,
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function calls(log: string, arg: string): number {
  try {
    return readFileSync(log, "utf8").split("\n").filter((line) => line === arg).length;
  } catch {
    return 0;
  }
}

test("createAgentRefresher: calls made during a refresh share one follow-up instead of each detecting again", async () => {
  await withTmpDir(async (dir) => {
    const log = join(dir, "calls.log");
    const def = fixtureDef("counted", writeCountingScript(dir, "counted-cli.cjs", log, 300), CATALOG);
    const { targets } = recordingTargets([def], dir);
    const refresh = createAgentRefresher(targets);

    const first = refresh();
    const second = refresh();
    const third = refresh();
    assert.equal(second, third, "every call made while one runs waits for the same follow-up");
    const results = await Promise.all([first, second, third]);

    assert.ok(results.every((detections) => detections[0].installed));
    assert.equal(calls(log, "--version"), 2, "the running refresh plus one follow-up");
  });
});

test("createAgentRefresher: a catalog probe still running is not started again by the next refresh", async () => {
  await withTmpDir(async (dir) => {
    const log = join(dir, "calls.log");
    const bin = writeCountingScript(dir, "probed-cli.cjs", log, 1000);
    const def: AgentRuntimeDef = {
      ...fixtureDef("probed", bin, CATALOG),
      models: { kind: "cli-probe", args: ["models"], parse: (stdout) => (stdout.includes("MODELS") ? CATALOG : undefined) },
    };
    const { targets, published } = recordingTargets([def], dir);
    const refresh = createAgentRefresher(targets);

    await refresh();
    await refresh();
    const deadline = Date.now() + 10_000;
    while (!published.catalogs.probed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(published.catalogs.probed, CATALOG);
    assert.equal(calls(log, "models"), 1);
  });
});
