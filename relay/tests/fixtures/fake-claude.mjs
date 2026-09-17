#!/usr/bin/env node
// The relay's one sanctioned mock boundary (see .anywh/skills/tests/SKILL.md
// — "The one sanctioned mock boundary: the `claude` process"). Stands in for
// the real `claude` binary in integration tests via the `AGENT_BIN` env var
// (relay/src/runtimes/executables.ts already reads it, no source change needed).
//
// Understands the two invocation shapes the relay actually spawns:
//   - `-p <text> --output-format stream-json ...`  -> a real turn
//     (runtimes/defs/claude/session.ts sendTurn)
//   - `-p /model --output-format json ...`          -> the default-model
//     probe (defaultModel.ts detectDefaultModel)
// Everything else (`auth status --json`) gets a canned success reply so
// routes that shell out to it don't error during a test that isn't
// exercising that path.
//
// Behavior is controlled by env vars so each test can shape the reply
// without touching this file:
//   FAKE_CLAUDE_REPLY  - assistant text to emit (default: "ok")
//   FAKE_CLAUDE_ERROR  - if set, the turn's `result` event comes back with
//                        `is_error: true` and this as the message
//   FAKE_CLAUDE_HANG   - if set, emits the `system`/`init` event and then
//                        waits (no `assistant`/`result`) until it receives
//                        SIGINT, mirroring the real binary's tested behavior
//                        (runtimes/defs/claude/session.ts's `stop()` comment: `claude -p`
//                        catches SIGINT and exits 0 with a valid `result`,
//                        `session_id` included, instead of dying raw) — lets
//                        a test drive the relay's "Stop" path
//                        (`session.stopTurn()`) against a turn that's
//                        genuinely still in flight, not one that already
//                        raced to completion before the test could send it.
//   FAKE_CLAUDE_PRESENT_CHOICE - if set (a JSON `ChoiceQuestion[]`), speaks
//                        the real MCP "Streamable HTTP" handshake
//                        (initialize -> tools/call) against the
//                        `anywh-choice` server URL found in this
//                        invocation's own `--mcp-config`, exactly like the
//                        real `claude` binary calling `present_choice` mid-
//                        turn — but deterministically, no model
//                        involved. This is what lets the deferred-lifecycle
//                        rework (relay/tests/choicePrompt.test.ts) be
//                        exercised against the REAL McpChoiceBridge/
//                        SharedSession/HTTP stack end to end (only the
//                        model's decision to call the tool at all is faked;
//                        everything downstream of that decision is real).
//                        The tool call's response (should be
//                        `CHOICE_DEFERRED_RESPONSE_TEXT`, mcpBridge.ts) is
//                        folded into the turn's final assistant text so a
//                        test can assert on it, then the turn ends normally
//                        — proving the process doesn't stay blocked waiting
//                        for a human the way the pre-rework version did.
//   FAKE_CLAUDE_SCHEDULE_WAKEUP - if set (JSON `{delaySeconds, prompt,
//                        stop?}`), emits an `assistant` event with a
//                        `tool_use` block for the native `ScheduleWakeup`
//                        tool, followed by its own `tool_result` (a plain
//                        ack — the real harness handles this tool
//                        internally, there's no server for this fixture to
//                        call into), then a normal assistant reply and a
//                        successful `result`. This is what lets
//                        wakeupScheduler integration tests exercise
//                        `WakeupScheduler.observeEvent` against the REAL
//                        `tool_started`/`tool_ended` shape `mapClaudeEvent`
//                        produces (relay/src/runtimes/streams/claudeStreamJson.ts),
//                        without a model ever actually calling the tool —
//                        same "fake only the model's decision, keep
//                        everything downstream real" shape as
//                        FAKE_CLAUDE_PRESENT_CHOICE above.
//   FAKE_CLAUDE_STATUS_PERMISSION_MODE - if set (a permission mode string),
//                        emits a `{"type":"system","subtype":"status",
//                        "permissionMode":...}` event right after `init` —
//                        the real binary's own shape for reporting a
//                        permission-mode transition it decided on its own
//                        mid-turn (e.g. right after an `ExitPlanMode`
//                        approval), confirmed against it
//                        (sharedSession.ts's `applyPermissionModeFromCli`).

import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** `emit` + exit, for the one caller that has to exit immediately after
 * writing: the write callback is what guarantees the line actually left for
 * the pipe first (see the SIGINT handler below for what this cost). */
function emitAndExit(event, code = 0) {
  process.stdout.write(`${JSON.stringify(event)}\n`, () => {
    process.exit(code);
  });
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// Must match `CHOICE_MCP_SERVER_NAME` in mcpBridge.ts.
const CHOICE_SERVER_NAME = "anywh-choice";

/** Speaks just enough of the real MCP "Streamable HTTP" handshake to call
 * `present_choice` against the relay's own `McpChoiceBridge` — see
 * `FAKE_CLAUDE_PRESENT_CHOICE` above for why this exists. Returns the tool
 * call's response text (`CHOICE_DEFERRED_RESPONSE_TEXT` on the happy path,
 * `mcpBridge.ts`), not an answer — under the deferred lifecycle there isn't
 * one yet. */
async function callPresentChoice(mcpConfigJson, questions) {
  const { mcpServers } = JSON.parse(mcpConfigJson);
  const url = mcpServers[CHOICE_SERVER_NAME].url;
  let nextId = 0;
  const rpc = async (method, params) => {
    nextId += 1;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params }),
    });
    return res.json();
  };
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const callResult = await rpc("tools/call", { name: "present_choice", arguments: { questions } });
  return callResult.result?.content?.[0]?.text ?? "";
}

if (args[0] === "--version") {
  // Real shape: a bare version number followed by a parenthesized product
  // name. runtimes/detection.ts only checks the exit code and trims
  // stdout — this exists so a test can assert `installed: true` against
  // this fixture the same way it would against the real binary.
  process.stdout.write("2.1.0 (Claude Code)\n");
  process.exit(0);
} else if (args[0] === "auth" && args[1] === "status") {
  emit({ loggedIn: true, email: "fake@anywh.test", subscriptionType: "pro" });
  process.exit(0);
} else if (args[0] === "-p") {
  const outputFormat = flagValue("--output-format");
  const resumeId = flagValue("--resume");
  const sessionId = resumeId ?? randomUUID();

  if (outputFormat === "json") {
    // The default-model probe (defaultModel.ts) — a single JSON line whose
    // `result` field is CLI usage text, not conversation output.
    emit({
      result:
        "Current model: `Sonnet 5 (default)`\n" +
        "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.",
    });
    process.exit(0);
  }

  const replyText = process.env.FAKE_CLAUDE_REPLY ?? "ok";
  const errorMessage = process.env.FAKE_CLAUDE_ERROR;
  const model = "claude-fake-5";

  // Gated on `--output-format stream-json` specifically (real turns only,
  // runtimes/defs/claude/session.ts's `sendTurn`), not just "any -p invocation": title
  // generation and next-message suggestion (titleGenerator.ts/
  // suggestionGenerator.ts) both fire their OWN `-p` calls in parallel with a
  // real turn (SharedSession.runTurn's `onFirstPrompt`) using the identical
  // prompt text but `--output-format text` — without this gate, setting
  // FAKE_CLAUDE_HANG for one turn also hung those unrelated spawns forever,
  // since nothing ever sends them SIGINT.
  const hanging = Boolean(process.env.FAKE_CLAUDE_HANG) && outputFormat === "stream-json";

  // Registered BEFORE the `system` event goes out, not alongside the
  // keep-alive below. `system` is the exact signal the relay waits for
  // before it is allowed to interrupt (runtimes/defs/claude/session.ts's `stop()`), so
  // announcing readiness first and only then installing the handler leaves a
  // window where SIGINT lands on Node's default action and kills this
  // process outright — no `result`, no `session_id`, and a turn that looks
  // like it was never interrupted cleanly. Measured against this fixture
  // (2026-09-13): 56 of 80 interrupts under parallel load fell in that
  // window, which is what made the stop_turn test flaky — and, before the
  // teardown fix in helpers/testServer.ts, what turned that flake into a
  // hung CI job rather than a failing one.
  if (hanging) {
    // Never resolves on its own — only SIGINT (relay's stopTurn ->
    // ClaudeSession.stop) moves this forward, same as the real binary's
    // tested interrupt behavior.
    process.once("SIGINT", () => {
      // `is_error: true` on a clean exit(0) is what the real binary reports
      // for an interrupted turn (confirmed against it, see runtimes/defs/claude/session.ts's
      // `stop()` doc comment) — `sendTurn` only classifies a turn as
      // `stopped: true` via the `lastErrorResult` branch, not the exit-code
      // one, so an `is_error: false` reply here (as a genuinely successful
      // turn would send) was silently misreported as `stopped: false`.
      emitAndExit({
        type: "result",
        session_id: sessionId,
        is_error: true,
        result: "interrompido pelo usuário",
        errors: ["interrompido pelo usuário"],
        modelUsage: { [model]: { contextWindow: 200000 } },
      });
    });
  }

  emit({ type: "system", subtype: "init", session_id: sessionId, model });

  if (process.env.FAKE_CLAUDE_STATUS_PERMISSION_MODE && outputFormat === "stream-json") {
    emit({ type: "system", subtype: "status", session_id: sessionId, permissionMode: process.env.FAKE_CLAUDE_STATUS_PERMISSION_MODE });
  }

  if (hanging) {
    // Keep the process alive indefinitely while waiting for that signal.
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_CLAUDE_PRESENT_CHOICE && outputFormat === "stream-json") {
    // Calls the real bridge, gets back the deferred `tool_result`, and ends
    // the turn immediately with that text as the "assistant reply" — this
    // is the behavioral claim under test: the process does NOT block
    // waiting for a human, unlike the pre-rework version of this mechanism.
    const questions = JSON.parse(process.env.FAKE_CLAUDE_PRESENT_CHOICE);
    const toolResultText = await callPresentChoice(flagValue("--mcp-config"), questions);
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: toolResultText }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      is_error: false,
      result: toolResultText,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    process.exit(0);
  } else if (process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP && outputFormat === "stream-json") {
    const call = JSON.parse(process.env.FAKE_CLAUDE_SCHEDULE_WAKEUP);
    const toolUseId = "toolu_fake_wakeup";
    const input = call.stop ? { stop: true } : { delaySeconds: call.delaySeconds, prompt: call.prompt };
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", id: toolUseId, name: "ScheduleWakeup", input }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    // The real harness executes `ScheduleWakeup` internally (it's a native
    // tool, not an MCP server) — this fixture only needs to produce the same
    // `tool_result` shape the CLI's own stream-json would, not actually
    // implement the tool.
    emit({
      type: "user",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Wakeup scheduled.", is_error: false }],
      },
    });
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: replyText }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      is_error: false,
      result: replyText,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    process.exit(0);
  } else if (process.env.FAKE_CLAUDE_TWO_USAGE_EVENTS && outputFormat === "stream-json") {
    // Two main-thread assistant events with distinct prefixes, before the
    // turn ends — exercises the live chip (SharedSession.runTurn's
    // ContextAttributor wiring), which needs to see more than one `usage`
    // mid-turn to prove it updates before `turn_ended`, not just once at
    // the end from the `result` event.
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: "thinking out loud" }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: replyText }],
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      is_error: false,
      result: replyText,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    process.exit(0);
  } else if (process.env.FAKE_CLAUDE_PARALLEL_TOOLS && outputFormat === "stream-json") {
    // Two tool_use blocks in ONE assistant message (real parallel tool
    // calls, not two sequential turns) followed by both tool_results in one
    // `user` message — exercises SharedSession's context_attribution
    // fan-out for a real batch, not the pure unit test's synthetic one.
    // Deliberately different content lengths (1 char vs 10) so a test can
    // tell the proportional division apart from an even split.
    const toolUseIdA = "toolu_parallel_a";
    const toolUseIdB = "toolu_parallel_b";
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          { type: "tool_use", id: toolUseIdA, name: "Bash", input: { command: "echo a" } },
          { type: "tool_use", id: toolUseIdB, name: "Bash", input: { command: "echo bbbbbbbbbb" } },
        ],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "user",
      session_id: sessionId,
      message: {
        content: [
          { type: "tool_result", tool_use_id: toolUseIdA, content: "a", is_error: false },
          { type: "tool_result", tool_use_id: toolUseIdB, content: "bbbbbbbbbb", is_error: false },
        ],
      },
    });
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: replyText }],
        usage: { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      is_error: false,
      result: replyText,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    process.exit(0);
  } else {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: replyText }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    emit({
      type: "result",
      session_id: sessionId,
      is_error: Boolean(errorMessage),
      result: errorMessage ?? replyText,
      errors: errorMessage ? [errorMessage] : undefined,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
    process.exit(0);
  }
} else {
  emit({ type: "result", is_error: true, result: `fake-claude: unrecognized invocation: ${args.join(" ")}` });
  process.exit(1);
}
