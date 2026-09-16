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

if (args[0] === "auth" && args[1] === "status") {
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
