import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./helpers/testServer.js";
import { collectUntil, connectSession, isTurnEnded, sendUserMessage } from "./helpers/wsClient.js";
import { readRuleTokens, computeResidual } from "../src/context/breakdown.js";
import type { ContextAccounting } from "../src/runtimes/types.js";

// Real integration test (.anywh/skills/tests/SKILL.md) for the
// request_context_breakdown wire message: proves the relay reads a real
// CLAUDE.md from the session's own cwd, tokenizes it with the real
// gpt-tokenizer dependency, and broadcasts the result cached onto
// context_usage_state's usage.breakdown — against the real WebSocket/HTTP
// stack, only the `claude` process itself is faked.

const CLAUDE_ACCOUNTING: ContextAccounting = {
  encoding: "cl100k_base",
  rules: { multiplier: 1.1262, perFile: 83 },
  emptyDirectoryInflation: 2233,
};

let server: TestServer;
let workDir: string;

before(async () => {
  server = await startTestServer();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "anywh-context-breakdown-")));
  writeFileSync(join(workDir, "CLAUDE.md"), "# Rules\n\nAlways write commits in English.\n".repeat(10));
});

after(async () => {
  await server.close();
  rmSync(workDir, { recursive: true, force: true });
});

function hasBreakdown(message: Record<string, unknown>): boolean {
  if (message.type !== "context_usage_state") return false;
  const usage = message.usage as { breakdown?: unknown } | null;
  return usage?.breakdown !== undefined;
}

test("request_context_breakdown reads the session's real CLAUDE.md and broadcasts a cached breakdown", async () => {
  const socket = await connectSession(server.port, "session-context-breakdown");

  socket.send(JSON.stringify({ type: "set_cwd", path: workDir }));
  await new Promise<void>((resolveCwd) => {
    function onMessage(raw: Buffer): void {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === "cwd_state") {
        socket.off("message", onMessage);
        resolveCwd();
      }
    }
    socket.on("message", onMessage);
  });

  // A turn has to complete first — there's nothing to attach a breakdown to
  // until `contextUsage` itself exists (see SharedSession.requestContextBreakdown's
  // own guard). The fake claude fixture's default usage is `input_tokens: 10`
  // with no prior conversation, so this session's baseline is exactly 10.
  sendUserMessage(socket, "hello");
  await collectUntil(socket, isTurnEnded);

  socket.send(JSON.stringify({ type: "request_context_breakdown" }));
  const messages = await collectUntil(socket, hasBreakdown);
  const breakdownMessage = messages.find(hasBreakdown)!;
  const usage = breakdownMessage.usage as { baselineTokens: number; breakdown: { rules?: { tokens: number; estimated: boolean }; residual?: { tokens: number; estimated: boolean } } };

  assert.equal(usage.baselineTokens, 10);
  assert.ok(usage.breakdown.rules, "expected a rules estimate for a cwd with a real CLAUDE.md");
  assert.equal(usage.breakdown.rules.estimated, true);

  // Recomputed independently here (not a hardcoded magic number) against the
  // same real file and the same calibration constants the claude def
  // declares — proves the wire result matches the pure formula, not just
  // that some number came back.
  const expectedRulesTokens = await readRuleTokens(workDir, "CLAUDE.md", CLAUDE_ACCOUNTING);
  assert.equal(usage.breakdown.rules.tokens, expectedRulesTokens);

  // The rules estimate (perFile alone is 83) dwarfs a baseline of 10 —
  // real overshoot case, not synthetic: proves the wire path clamps exactly
  // like the pure `computeResidual` does.
  assert.ok(usage.breakdown.residual, "expected a residual once baselineTokens is known");
  assert.equal(usage.breakdown.residual.tokens, computeResidual(10, expectedRulesTokens!));
  assert.equal(usage.breakdown.residual.tokens, 0);

  socket.close();
});
