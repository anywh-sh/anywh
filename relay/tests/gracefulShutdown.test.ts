import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnRelay } from "./helpers/spawnedServer.js";
import { collectUntil, connectSession, sendUserMessage } from "./helpers/wsClient.js";

// Real integration test, against a genuinely separate OS process (see
// spawnedServer.ts's own comment for why gracefulShutdown specifically
// can't reuse the in-process testServer.ts tier): server.ts's own doc
// comment on gracefulShutdown describes two behaviors — exit promptly once
// idle, and wait out a grace period before escalating to SIGINT for a turn
// stuck past it — neither had a test before this file.

test("gracefulShutdown: SIGTERM with no turn in progress exits promptly with code 0", async () => {
  const relay = await spawnRelay();
  try {
    const start = Date.now();
    relay.proc.kill("SIGTERM");
    const { code, signal } = await relay.waitForExit();
    assert.equal(code, 0);
    assert.equal(signal, null, "a clean process.exit(0), not killed by a signal");
    assert.ok(Date.now() - start < 5000, "no active turn means waitForAllIdle resolves immediately, no grace period to wait out");
    const output = relay.output.join("");
    assert.match(output, /no longer accepting new connections/);
    assert.match(output, /disposing session driver\(s\)/);
    assert.match(output, /exiting\./);
  } finally {
    relay.cleanup();
  }
});

test("gracefulShutdown: a turn stuck past the grace period gets SIGINT (same path as the Stop button), then the relay exits", async () => {
  // A short grace period (RELAY_SHUTDOWN_GRACE_MS) so the escalation path
  // triggers quickly instead of the real 4-minute default — this is what
  // proves escalation happens at all, not just that shutdown eventually
  // succeeds some other way.
  const relay = await spawnRelay({ RELAY_SHUTDOWN_GRACE_MS: "200", FAKE_CLAUDE_HANG: "1" });
  try {
    const socket = await connectSession(relay.port, "session-shutdown");
    sendUserMessage(socket, "please hang");

    // Same synchronization the existing stop_turn test uses: wait for the
    // fake claude's own `system`/`init` event (mapped to `session_id`),
    // proof the child has actually spawned and is genuinely blocked on
    // SIGINT, before shutting down.
    await collectUntil(socket, (message) => message.type === "agent_event" && (message.event as { type?: string }).type === "session_id");

    const start = Date.now();
    relay.proc.kill("SIGTERM");
    const { code } = await relay.waitForExit();
    const elapsedMs = Date.now() - start;

    assert.equal(code, 0);
    // Comfortably past the 200ms grace period (the wait actually happened),
    // comfortably under the 10s hard abort ceiling (SIGINT actually reached
    // the hung child and it exited cleanly, same contract stop_turn relies
    // on — this isn't the fallback path that gives up entirely).
    assert.ok(elapsedMs > 200, `expected the grace period to be waited out, took only ${elapsedMs}ms`);
    assert.ok(elapsedMs < 5000, `expected SIGINT to resolve the turn well under the 10s abort ceiling, took ${elapsedMs}ms`);

    const output = relay.output.join("");
    assert.match(output, /turn\(s\) still in progress after 200ms — aborting with SIGINT/);
    assert.match(output, /disposing session driver\(s\)/);
    assert.match(output, /exiting\./);
  } finally {
    relay.cleanup();
  }
});
