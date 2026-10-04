import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeModelCatalog } from "./modelCatalog.js";

// The `initialize` control_response verbatim from Claude Code 2.1.284
// (trimmed to five of its twelve entries, fields this parser ignores cut) —
// the same list, in the same order, as the CLI's own interactive `/model`
// picker on the same account.
const REAL_REPLY = JSON.stringify({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "anywh-models",
    response: {
      commands: [],
      models: [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
        { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
        { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday, complex tasks" },
      ],
    },
  },
});

test("parseClaudeModelCatalog: every concrete model with the CLI's own name, the default pseudo-entry folded into defaultId", () => {
  assert.deepEqual(parseClaudeModelCatalog(`${REAL_REPLY}\n`), {
    options: [
      { id: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks" },
      { id: "claude-fable-5-1", label: "Fable 5.1", description: "For your toughest challenges" },
      { id: "sonnet", label: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
      { id: "claude-opus-4-8", label: "Opus 4.8", description: "Best for everyday, complex tasks" },
    ],
    defaultId: "opus",
  });
});

test("parseClaudeModelCatalog: finds the reply among other stream-json lines", () => {
  const stdout = `${JSON.stringify({ type: "system", subtype: "init" })}\nnot json at all\n${REAL_REPLY}\n`;
  assert.equal(parseClaudeModelCatalog(stdout)?.defaultId, "opus");
});

test("parseClaudeModelCatalog: undefined until the reply has arrived whole", () => {
  assert.equal(parseClaudeModelCatalog(""), undefined);
  assert.equal(parseClaudeModelCatalog(REAL_REPLY.slice(0, REAL_REPLY.length / 2)), undefined);
});

test("parseClaudeModelCatalog: no default pseudo-entry means no defaultId, not a guess", () => {
  const reply = JSON.stringify({
    type: "control_response",
    response: { response: { models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" }] } },
  });
  assert.deepEqual(parseClaudeModelCatalog(reply), { options: [{ id: "sonnet", label: "Sonnet 5.5" }] });
});

// Effort fields as Claude Code 2.1.289 reports them: per-model levels (no
// `max` list difference on 4.6 — it lacks `xhigh`), nothing at all on Haiku,
// and no default effort anywhere.
test("parseClaudeModelCatalog: efforts come from supportedEffortLevels when supportsEffort, never a default", () => {
  const reply = JSON.stringify({
    type: "control_response",
    response: {
      response: {
        models: [
          { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
          { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
        ],
      },
    },
  });
  const catalog = parseClaudeModelCatalog(reply);
  assert.deepEqual(catalog?.options[0]?.efforts?.map((e) => e.id), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(catalog?.options[1]?.efforts?.map((e) => e.id), ["low", "medium", "high", "max"]);
  assert.equal("efforts" in (catalog?.options[2] ?? {}), false);
  assert.equal(catalog?.options.some((o) => "defaultEffort" in o), false);
});
