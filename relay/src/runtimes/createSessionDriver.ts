// The one place outside registry.ts allowed to branch on ExecPlan's `kind`
// (architecture.test.ts's tripwire only forbids that OUTSIDE runtimes/) —
// picks a concrete AgentSessionDriver for a def, so SharedSession never has
// to know `exec.kind` exists at all.
import type { AgentRuntimeDef } from "./types.js";
import type { AgentSessionDriver, SessionDriverHost } from "./sessionDriver.js";
import { ClaudeSessionDriver, type ClaudeMcpWiring } from "./defs/claude/index.js";

export interface CreateSessionDriverOptions {
  readonly homeOverride?: string;
  readonly initialSessionId?: string;
  readonly host: SessionDriverHost;
  /** Claude-specific MCP bridge wiring — `undefined` for any non-Claude def
   * (and in tests that don't exercise the bridged approval path). A def
   * whose `exec.kind` isn't `"spawnPerTurn"` never reads this. */
  readonly claudeMcp?: ClaudeMcpWiring;
}

export function createSessionDriver(def: AgentRuntimeDef, options: CreateSessionDriverOptions): AgentSessionDriver {
  switch (def.exec.kind) {
    case "spawnPerTurn":
      // No generic spawn-per-turn engine exists yet — docs/invariants.md's
      // own directional note says this extraction "hasn't happened yet."
      // Honest for a registry of exactly one spawn-per-turn def: this
      // branch is really "Claude" wearing the def's name, not a dispatch a
      // second spawn-per-turn agent could plug into without this function
      // changing. Revisit if a second one arrives.
      return new ClaudeSessionDriver({
        homeOverride: options.homeOverride,
        initialSessionId: options.initialSessionId,
        host: options.host,
        mcp: options.claudeMcp,
      });
    case "jsonRpcDaemon":
      // Codex's own driver lands in a later phase (Fase 10's daemon
      // lifecycle/notification-mapper/def work is done — this is the one
      // piece still missing before a session can actually pick it).
      throw new Error(`no session driver for exec.kind "jsonRpcDaemon" yet (def "${def.identity.id}")`);
    case "custom":
      throw new Error(`no session driver for exec.kind "custom" (def "${def.identity.id}")`);
  }
}
