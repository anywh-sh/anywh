import type { Server } from "node:http";
import type { SessionManager } from "./session/sessionManager.js";

// `true` from the first SIGTERM/SIGINT received onward — rejects a new turn
// (ws/chat.ts's `isUserMessage`/`isEditMessageMessage` branches) while
// `gracefulShutdown` waits for turns already in progress to finish.
export let shuttingDown = false;

// How long to wait for turn(s) in progress to finish on their own before
// giving up and aborting via SIGINT (see below) — generous on purpose
// (long responses exist), but configurable so adjusting it doesn't require
// a rebuild. The systemd unit's `TimeoutStopSec` needs to stay GREATER than
// this + `SHUTDOWN_ABORT_GRACE_MS`, otherwise systemd sends SIGKILL to the
// whole cgroup before we even finish waiting.
const SHUTDOWN_GRACE_MS = Number(process.env.RELAY_SHUTDOWN_GRACE_MS ?? 4 * 60 * 1000);
// After the fallback SIGINT (same path as the "Stop" button — tested
// against the real binary, exits cleanly with a valid `result`), how long
// to wait for the `claude -p` process to actually finish before exiting anyway.
const SHUTDOWN_ABORT_GRACE_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GracefulShutdownDeps {
  httpServer: Pick<Server, "close">;
  sessionManager: Pick<SessionManager, "waitForAllIdle" | "stopAllTurns" | "disposeAll">;
}

/**
 * SIGTERM (`systemctl restart`/`stop`) or SIGINT (Ctrl+C in dev) — by
 * default systemd (`KillMode=control-group`, deliberately not used here,
 * see infra/systemd/) would send the signal to the child `claude -p`
 * process at the same time as the relay, killing a turn in progress raw
 * (only the SIGINT sent by the "Stop" button was validated as a clean exit,
 * not SIGTERM). With `KillMode=mixed` on the unit, only the relay receives
 * the signal — this function stops accepting new connections and new
 * turns, waits for turns already in progress to finish on their own, and
 * only resorts to SIGINT (`stopTurn`, same path as the "Stop" button) if
 * one gets stuck past the grace period.
 */
export async function gracefulShutdown(signal: NodeJS.Signals, deps: GracefulShutdownDeps): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[relay] ${signal} received — no longer accepting new connections, waiting for turn(s) in progress...`);
  deps.httpServer.close();

  const idle = deps.sessionManager.waitForAllIdle();
  const timedOut = await Promise.race([idle.then(() => false), delay(SHUTDOWN_GRACE_MS).then(() => true)]);

  if (timedOut) {
    console.warn(
      `[relay] turn(s) still in progress after ${SHUTDOWN_GRACE_MS}ms — aborting with SIGINT (same path as the "Stop" button) before exiting.`,
    );
    deps.sessionManager.stopAllTurns();
    await Promise.race([idle, delay(SHUTDOWN_ABORT_GRACE_MS)]);
  }

  // Tears down anything a driver holds open past a single turn (a Codex
  // daemon process) — a no-op per session until a Codex-driven session
  // exists in production, but the only place in the shutdown sequence that
  // will ever run once that's true. After the idle-wait/abort-SIGINT
  // sequence above, not before it: a turn still finishing its own cleanup
  // shouldn't have its driver torn out from under it.
  console.log("[relay] disposing session driver(s)...");
  deps.sessionManager.disposeAll();

  console.log("[relay] exiting.");
  process.exit(0);
}
