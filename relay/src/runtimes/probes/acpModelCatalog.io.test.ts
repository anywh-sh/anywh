import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeModelCatalog } from "./modelCatalog.js";
import { acpInitialize, acpInterrupt, acpThreadStart, acpTurnStart } from "../defs/acp.js";
import type { AgentRuntimeDef } from "../types.js";

// Against `tests/fixtures/fake-acp-agent.mjs` (ACP shapes of Kimi Code CLI
// 2.6.0): the fake's picker lists two models whose reasoning levels differ,
// the way Kimi's do.
const FAKE_AGENT = resolve(import.meta.dirname, "../../../tests/fixtures/fake-acp-agent.mjs");

const def: AgentRuntimeDef = {
  identity: { id: "fake-acp", bin: FAKE_AGENT, env: { strip: ["FAKE_ACP_API_KEY"] }, projectInstructionsFile: "AGENTS.md" },
  capabilities: { presentChoice: "none", approvalPrompt: "native", rewindTurn: "none", replayHistory: "none", backgroundJobs: "none", thinking: "none", contextUsage: "none" },
  continuity: { kind: "cli-resume", resumeStyle: "capture" },
  models: { kind: "session-rpc" },
  auth: { kind: "none" },
  permissions: { defaultModeId: "default", modesFor: () => [{ id: "default", labelKey: "x", settings: undefined, pausesForApproval: true }] },
  bridges: [],
  quickPrompt: { kind: "none" },
  exec: {
    kind: "jsonRpcDaemon",
    protocol: "acp",
    args: ["acp"],
    initialize: acpInitialize,
    framing: "ndjson",
    thread: { start: acpThreadStart },
    turn: { start: acpTurnStart, interrupt: acpInterrupt },
    mapNotification: () => [],
    handleServerRequest: () => undefined,
  },
  portability: { authoredPaths: [".fake/skills"], mcp: { kind: "none" } },
};

test("an ACP agent's catalog: every model of its picker, each with the levels it reports while selected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-models-"));
  process.env.FAKE_ACP_STATE = join(dir, "state.json");
  process.env.FAKE_ACP_LOG = join(dir, "log.jsonl");
  try {
    const catalog = await probeModelCatalog(def, undefined, dir);
    assert.deepEqual(catalog, {
      defaultId: "m1",
      options: [
        { id: "m1", label: "Model One", efforts: ["low", "high", "max"].map((id) => ({ id, description: `Thinking ${id}` })), defaultEffort: "high" },
        { id: "m2", label: "Model Two", efforts: ["on", "high"].map((id) => ({ id, description: `Thinking ${id}` })), defaultEffort: "high" },
      ],
    });
    // The throwaway session is gone from the agent's own history, and no
    // prompt was ever sent.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), {});
    const methods = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { method?: string }).method);
    assert.ok(!methods.includes("session/prompt"));
    assert.ok(methods.includes("session/delete"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every probe opens its throwaway session in the same folder, so the agent keeps no folder per probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-models-"));
  process.env.FAKE_ACP_STATE = join(dir, "state.json");
  process.env.FAKE_ACP_LOG = join(dir, "log.jsonl");
  try {
    await probeModelCatalog(def, undefined, dir);
    await probeModelCatalog(def, undefined, dir);
    const cwds = readFileSync(join(dir, "log.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { cwd?: string } })
      .filter((message) => message.method === "session/new")
      .map((message) => message.params?.cwd);
    assert.equal(cwds.length, 2);
    assert.equal(cwds[0], cwds[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent that can't start a session leaves the catalog unknown", async () => {
  const broken: AgentRuntimeDef = { ...def, identity: { ...def.identity, bin: "/nonexistent/acp-agent" } };
  assert.equal(await probeModelCatalog(broken, undefined, tmpdir()), undefined);
});
