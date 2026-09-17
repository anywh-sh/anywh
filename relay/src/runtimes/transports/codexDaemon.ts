// One `codex app-server` process per `SharedSession` (not per relay, not
// per turn) — a daemon holds one process per *session*, so it pays for a
// fresh spawn (and the `initialize` handshake below) only when a session
// actually starts talking to it, and can outlive many turns and `/clear`s
// (a new `thread/start` in the same process) before it's ever torn down.
//
// This file owns exactly the process-lifecycle concerns a JSON-RPC daemon
// needs that a spawn-per-turn CLI (runtimes/defs/claude/session.ts) never
// does: a handshake before anything else is meaningful, an idle reaper
// (nothing tears a daemon down just because a turn ended), and a kill
// primitive with escalation (there's no `close` event marking "the turn is
// over" the way a spawn-per-turn child's exit does). Sending an actual turn
// (`thread/start`, `turn/start`, `turn/interrupt`) is the caller's job via
// `request()` — those are per-session/per-turn concerns
// (`AgentRuntimeDef.exec`), not part of standing up the process itself.
import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildChildEnv } from "../../host/childEnv.js";
import { resolveAgentBin } from "../executables.js";
import { createJsonRpcConnection } from "./jsonRpcStdio.js";
import type { AgentRuntimeDef, JsonRpcDaemonPlan, TurnHost } from "../types.js";

// Same pattern as routes/host.ts's RELAY_VERSION — this file sits two
// directories deeper (runtimes/transports/, not routes/), hence the extra
// "../".
const PACKAGE_JSON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const RELAY_VERSION = (JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version: string }).version;

// A daemon that never hears from its session again (tab closed without a
// clean shutdown, client vanished) shouldn't sit there forever — 15 minutes
// with no `request()` activity is generous for a coding session (an
// in-flight turn's own requests count as activity, so this never fires
// mid-turn) but short enough that an abandoned daemon doesn't outlive the
// session that spawned it by much.
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// SIGTERM first, always — a daemon mid-write to its own on-disk state
// deserves the chance to exit cleanly. SIGKILL only if it ignores that.
const DEFAULT_KILL_GRACE_MS = 5000;

export type CodexDaemonExitReason = "idle" | "killed" | "crashed";

export interface CodexDaemon {
  /** Sends a request over the daemon's connection and resolves with its
   * result — the caller builds `method`/`params` from the def's own
   * `exec.thread.start`/`exec.turn.start`/`exec.interrupt`. Counts as
   * activity for the idle reaper. Rejects immediately, without touching the
   * process, once `exited` is true. */
  request(method: string, params: unknown): Promise<unknown>;
  /** `true` once the process has stopped accepting requests for any reason
   * — the owner should spawn a fresh daemon before the next turn rather
   * than reuse this one. */
  readonly exited: boolean;
  /** Terminates the daemon now (session close, a `cwd` change, the relay's
   * own shutdown sweep) — SIGTERM, escalating to SIGKILL if it hasn't
   * exited within the grace period. Idempotent: safe to call on an
   * already-exited daemon. */
  kill(): void;
}

export interface SpawnCodexDaemonOptions {
  /** Must have `exec.kind === "jsonRpcDaemon"` — the caller (a future
   * SharedSession/sessionManager integration) is the one that already
   * knows which def a session picked; this file doesn't select one. */
  readonly def: AgentRuntimeDef;
  readonly cwd: string;
  /** Overrides the child process's $HOME — same per-profile isolation
   * every other spawn in this relay uses. */
  readonly homeOverride?: string;
  /** Where a request the daemon initiates (an approval, structured input)
   * gets answered — the same `TurnHost` the MCP bridges answer for Claude,
   * per the contract (`runtimes/types.ts`). */
  readonly host: TurnHost;
  /** Every notification the daemon pushes, verbatim. Turning this into an
   * `AgentEvent` is `runtimes/streams/codexAppServer.ts`'s job (a later
   * phase), not this file's — a daemon shouldn't need to know the wire
   * vocabulary to manage its own process. */
  readonly onNotification: (method: string, params: unknown) => void;
  /** Fires exactly once, whenever `exited` flips true for any reason —
   * never fires at all if the process dies before `initialize` completes,
   * since there's no `CodexDaemon` yet to report an exit on; that failure
   * surfaces as the returned promise rejecting instead. */
  readonly onExit: (reason: CodexDaemonExitReason) => void;
  readonly idleTimeoutMs?: number;
  readonly killGraceMs?: number;
}

function isJsonRpcDaemonPlan(def: AgentRuntimeDef): def is AgentRuntimeDef & { exec: JsonRpcDaemonPlan } {
  return def.exec.kind === "jsonRpcDaemon";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Spawns the process and completes the `initialize` handshake before
 * resolving — a daemon that hasn't initialized can't be trusted with
 * `thread/start` yet. Rejects if the process fails to spawn, errors, or
 * exits before `initialize` answers (including the far end answering with a
 * JSON-RPC error) — the caller is expected to surface a "not
 * installed"/crashed error rather than retry blindly against a process
 * that's already gone.
 */
export function spawnCodexDaemon(options: SpawnCodexDaemonOptions): Promise<CodexDaemon> {
  if (!isJsonRpcDaemonPlan(options.def)) {
    return Promise.reject(new Error(`spawnCodexDaemon: def "${options.def.identity.id}" has no jsonRpcDaemon exec plan`));
  }
  const exec = options.def.exec;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const bin = resolveAgentBin(options.def.identity.bin);
  const stripCredentials = (env: NodeJS.ProcessEnv): void => {
    for (const name of options.def.identity.env.strip) delete env[name];
  };
  const env = buildChildEnv(options.homeOverride, [], stripCredentials, options.def.identity.env.set);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ["app-server"], { env, cwd: options.cwd });
  } catch (error) {
    return Promise.reject(toError(error));
  }

  let exited = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  // Only the idle timer — NOT `killTimer`, which must be allowed to fire
  // even after `exited` flips true. A real finding writing this file's own
  // tests: `kill()` calls `sendKillSignal()` (which schedules `killTimer`
  // for the SIGKILL escalation) and then `finish("killed")` right after —
  // if `finish` cleared `killTimer` too, the escalation it had just
  // scheduled would be cancelled before it ever got to run, and a process
  // ignoring SIGTERM would never actually die.
  function clearIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // `child.killed` is true as soon as a signal is successfully *sent* — it
  // says nothing about whether the process has actually exited, which is
  // exactly what the SIGKILL escalation below needs to know. `processExited`
  // (set from the real `exit` event) is the honest signal.
  let processExited = false;

  function sendKillSignal(): void {
    if (processExited) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!processExited) child.kill("SIGKILL");
    }, killGraceMs);
  }

  const connection = createJsonRpcConnection({
    framing: exec.framing,
    write: (chunk) => child.stdin.write(chunk),
    onNotification: options.onNotification,
    onRequest: (method, params) => exec.handleServerRequest(method, params, options.host),
  });
  child.stdout.on("data", (chunk: Buffer) => connection.receive(chunk.toString("utf8")));

  return new Promise((resolvePromise, rejectPromise) => {
    // Set only once the handshake resolves successfully — its presence is
    // what tells the exit/error listeners below whether a live
    // `CodexDaemon` exists to report `onExit` on, or whether the outer
    // promise itself still needs to be settled instead.
    let daemon: CodexDaemon | undefined;

    function finish(reason: CodexDaemonExitReason): void {
      if (exited) return;
      exited = true;
      clearIdleTimer();
      if (daemon) {
        options.onExit(reason);
      } else {
        rejectPromise(new Error(`codex daemon process ended before "initialize" completed (reason: ${reason})`));
      }
    }

    child.on("exit", () => {
      processExited = true;
      if (killTimer) clearTimeout(killTimer); // the process is confirmed gone; the SIGKILL escalation (if any) has nothing left to do
      finish("crashed");
    });
    child.on("error", (error) => {
      processExited = true;
      if (killTimer) clearTimeout(killTimer);
      if (daemon) {
        finish("crashed");
        return;
      }
      // Still mid-handshake: surface the real spawn error (e.g. ENOENT)
      // instead of the generic message `finish` would produce.
      if (exited) return;
      exited = true;
      clearIdleTimer();
      rejectPromise(toError(error));
    });

    function kill(): void {
      if (exited) return;
      sendKillSignal();
      finish("killed");
    }

    function scheduleIdleCheck(): void {
      if (exited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        sendKillSignal();
        finish("idle");
      }, idleTimeoutMs);
    }

    const clientInfo = { name: "anywh", title: null, version: RELAY_VERSION };
    // `experimentalApi: true` is required for the daemon to accept an
    // `askForApproval.granular` value at all — confirmed live: without this,
    // EVERY `turn/start` in `workspace-write` mode (the def's own
    // `settingsFor`, runtimes/defs/codex.ts) is rejected outright with
    // `{"code":-32600,"message":"askForApproval.granular requires
    // experimentalApi capability"}`, before the turn even starts. `granular`
    // is the only way to express "pause only when the sandbox itself blocks
    // something" in the real protocol (the legacy `on-failure` config value
    // this def used to send doesn't exist in the wire `AskForApproval`
    // union) — so this capability is on for every Codex session, not just
    // ones that pick `workspace-write`, since the handshake is per-process
    // (one daemon per session, not per turn). `experimentalApi`'s own doc
    // comment in the generated bindings describes it as "opt into receiving
    // experimental API methods and fields" — broader than just granular
    // approval, and by definition unstable across `codex-cli` releases;
    // accepted here because it's the only way to use `granular` today, not
    // because the scope is fully known. `requestAttestation: false`: the
    // other half of `InitializeCapabilities`, unrelated to approvals — no
    // attestation flow exists anywhere in this relay to opt into.
    connection.request("initialize", { clientInfo, capabilities: { experimentalApi: true, requestAttestation: false } }).then(
      () => {
        if (exited) return; // already settled via the exit/error listeners above
        scheduleIdleCheck();
        daemon = {
          request(method, params) {
            if (exited) return Promise.reject(new Error(`codex daemon already exited, cannot send "${method}"`));
            scheduleIdleCheck();
            return connection.request(method, params);
          },
          get exited() {
            return exited;
          },
          kill,
        };
        resolvePromise(daemon);
      },
      (error: unknown) => {
        if (exited) return; // already settled via the exit/error listeners above
        exited = true;
        clearIdleTimer();
        sendKillSignal();
        rejectPromise(toError(error));
      },
    );
  });
}
