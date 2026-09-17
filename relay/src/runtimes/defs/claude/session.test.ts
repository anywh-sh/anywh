import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnArgs, extractContextUsage, isMainThreadEvent, isSessionInvalidError, type ClaudeEvent } from "./session.js";

/** The value passed to `--append-system-prompt` — every case below folds
 * something into this single joined string rather than a separate flag. */
function appendSystemPromptValue(args: readonly string[]): string {
  const index = args.indexOf("--append-system-prompt");
  assert.notEqual(index, -1, "expected --append-system-prompt in argv");
  return args[index + 1];
}

// Real shapes, captured by actually running `claude -p` (see the context
// window indicator plan) — used as the basis for the tests below so the
// assertion doesn't drift from the CLI's real format.
function resultEvent(overrides: Partial<ClaudeEvent> = {}): ClaudeEvent {
  return {
    type: "result",
    session_id: "sess-1",
    modelUsage: {
      "claude-sonnet-5": { contextWindow: 1_000_000, canonicalModel: "claude-sonnet-5" },
    },
    ...overrides,
  };
}

function assistantUsage(overrides: Record<string, unknown> = {}) {
  return {
    input_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 30691,
    output_tokens: 4,
    ...overrides,
  };
}

test("extracts model/contextWindowSize/usedTokens by combining the last main-thread assistant with the result", () => {
  const usage = extractContextUsage(resultEvent(), "claude-sonnet-5", assistantUsage());
  assert.deepEqual(usage, {
    model: "claude-sonnet-5",
    contextWindowSize: 1_000_000,
    // input_tokens(2) + cache_creation_input_tokens(0) + cache_read_input_tokens(30691)
    // — output_tokens(4) is left out on purpose, same formula as Claude
    // Code's official statusline `used_percentage`.
    usedTokens: 30693,
  });
});

test("no main-thread usage seen yet (turn failed before any response): returns undefined", () => {
  assert.equal(extractContextUsage(resultEvent(), "claude-sonnet-5", undefined), undefined);
});

test("unknown model (init not captured): falls back to the first modelUsage entry instead of discarding", () => {
  const usage = extractContextUsage(resultEvent(), undefined, assistantUsage());
  assert.deepEqual(usage, {
    model: "claude-sonnet-5",
    contextWindowSize: 1_000_000,
    usedTokens: 30693,
  });
});

test("captured model doesn't match any modelUsage key: same fallback, doesn't return undefined", () => {
  const usage = extractContextUsage(resultEvent(), "claude-opus-5", assistantUsage());
  assert.deepEqual(usage, {
    model: "claude-sonnet-5",
    contextWindowSize: 1_000_000,
    usedTokens: 30693,
  });
});

test("no modelUsage field on the result event: returns undefined", () => {
  const event = resultEvent();
  delete event.modelUsage;
  assert.equal(extractContextUsage(event, "claude-sonnet-5", assistantUsage()), undefined);
});

test("modelUsage[model] without contextWindow: returns undefined instead of making up a limit", () => {
  const usage = extractContextUsage(
    resultEvent({ modelUsage: { "claude-sonnet-5": { canonicalModel: "claude-sonnet-5" } } }),
    "claude-sonnet-5",
    assistantUsage(),
  );
  assert.equal(usage, undefined);
});

test("empty modelUsage ({}): returns undefined instead of breaking on the fallback", () => {
  const usage = extractContextUsage(resultEvent({ modelUsage: {} }), "claude-sonnet-5", assistantUsage());
  assert.equal(usage, undefined);
});

test("missing usage fields on the assistant count as 0, don't break the sum", () => {
  const usage = extractContextUsage(resultEvent(), "claude-sonnet-5", { cache_read_input_tokens: 500 });
  assert.deepEqual(usage, {
    model: "claude-sonnet-5",
    contextWindowSize: 1_000_000,
    usedTokens: 500,
  });
});

test("ignores the result.usage aggregate — never reads tokens from there (real finding: sums the whole turn, including subagents)", () => {
  // `result.usage` here simulates the real shape that caused the "104%" bug
  // reported in a real session: a giant number that doesn't represent the
  // main thread's context. The function doesn't even look at that field.
  const usage = extractContextUsage(
    resultEvent({
      usage: { input_tokens: 30, cache_creation_input_tokens: 36_139, cache_read_input_tokens: 1_402_133 },
    }),
    "claude-sonnet-5",
    assistantUsage(),
  );
  assert.deepEqual(usage, {
    model: "claude-sonnet-5",
    contextWindowSize: 1_000_000,
    usedTokens: 30693,
  });
});

test("isMainThreadEvent: true when parent_tool_use_id is null or absent", () => {
  assert.equal(isMainThreadEvent({ type: "assistant", parent_tool_use_id: null }), true);
  assert.equal(isMainThreadEvent({ type: "assistant" }), true);
});

test("isSessionInvalidError: true for the CLI's real 'no conversation found' messages (--resume genuinely broken)", () => {
  // Exact strings captured by running the real binary against a bogus
  // session id (see runtimes/defs/claude/session.ts comment) and documented for the
  // "history not found" case.
  assert.equal(isSessionInvalidError("No conversation found with session ID: 00000000-0000-0000-0000-000000000000"), true);
  assert.equal(isSessionInvalidError("No conversation found to continue"), true);
});

test("isSessionInvalidError: false for transient errors — usage limit, overloaded, network — that don't invalidate the session", () => {
  // Real finding: treating these the same as a broken --resume wiped
  // sessionId (hence all conversation context) on every 5-hour usage-limit
  // hit or API hiccup, even though the session was still perfectly resumable.
  assert.equal(isSessionInvalidError("Claude AI usage limit reached|1735689600"), false);
  assert.equal(isSessionInvalidError("Overloaded"), false);
  assert.equal(isSessionInvalidError("connect ECONNREFUSED 127.0.0.1:443"), false);
});

test("isMainThreadEvent: false when parent_tool_use_id points at the tool_use that triggered a subagent", () => {
  // Real shape of a subagent's `assistant` event, captured by running a
  // real turn with `Task` — carries `parent_tool_use_id`, `subagent_type`,
  // and `task_description`, and a `usage` with isolated context
  // (cache_read_input_tokens: 0 — starts from zero, no cache from the main
  // conversation). The point is only `parent_tool_use_id`; the other fields
  // here are just to keep the example faithful to the real thing.
  assert.equal(
    isMainThreadEvent({
      type: "assistant",
      parent_tool_use_id: "toolu_01G3RYwin1us3gDnKrBpN2hv",
      subagent_type: "general-purpose",
    }),
    false,
  );
});

// buildTurnArgs — characterizes the argv built for a turn today, minus MCP
// flags and --resume (see the function's own comment for why those stay in
// sendTurn). Pinning behavior as it exists now, not redesigning it here.

test("buildTurnArgs: bypassPermissions uses --dangerously-skip-permissions, never --permission-mode", () => {
  const args = buildTurnArgs("hi", "bypassPermissions", undefined);
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--permission-mode"));
});

test("buildTurnArgs: every other mode passes --permission-mode <mode>, never the bypass flag", () => {
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    const args = buildTurnArgs("hi", mode, undefined);
    const index = args.indexOf("--permission-mode");
    assert.notEqual(index, -1, `expected --permission-mode for ${mode}`);
    assert.equal(args[index + 1], mode);
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  }
});

test("buildTurnArgs: --model is only present when a model was chosen", () => {
  const withModel = buildTurnArgs("hi", "default", "claude-sonnet-5");
  const modelIndex = withModel.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(withModel[modelIndex + 1], "claude-sonnet-5");

  const withoutModel = buildTurnArgs("hi", "default", undefined);
  assert.ok(!withoutModel.includes("--model"));
});

test("buildTurnArgs: plan mode folds the plan-mode choice marker into --append-system-prompt", () => {
  const planValue = appendSystemPromptValue(buildTurnArgs("hi", "plan", undefined));
  const defaultValue = appendSystemPromptValue(buildTurnArgs("hi", "default", undefined));
  // Marker text lives in bridges/planChoiceMarker.ts — asserting presence,
  // not duplicating its literal value here.
  assert.notEqual(planValue, defaultValue);
  assert.ok(planValue.length > defaultValue.length);
});

test("buildTurnArgs: extraSystemPrompt folds into --append-system-prompt alongside the base prompt", () => {
  const withoutExtra = appendSystemPromptValue(buildTurnArgs("hi", "default", undefined));
  const withExtra = appendSystemPromptValue(buildTurnArgs("hi", "default", undefined, "use present_choice for this"));
  assert.ok(withExtra.includes("use present_choice for this"));
  assert.ok(withExtra.startsWith(withoutExtra));
});

test("buildTurnArgs: base flags and prompt text are always present, in a stable order", () => {
  const args = buildTurnArgs("do the thing", "default", undefined);
  assert.deepEqual(args.slice(0, 6), ["-p", "do the thing", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
});
