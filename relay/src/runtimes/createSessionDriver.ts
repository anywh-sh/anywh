// The one place outside registry.ts allowed to branch on ExecPlan's `kind`
// (architecture.test.ts's tripwire only forbids that OUTSIDE runtimes/) —
// picks a concrete AgentSessionDriver for a def, so SharedSession never has
// to know `exec.kind` exists at all.
import type { AgentRuntimeDef } from "./types.js";
import type { AgentSessionDriver, SessionDriverHost } from "./sessionDriver.js";
import { ClaudeSessionDriver, type ClaudeMcpWiring } from "./defs/claude/index.js";
import { CodexSessionDriver } from "./defs/codexDriver.js";

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
      // CodexSessionDriver is the only driver of this shape today — same
      // "honest for a registry of exactly one" caveat as the spawnPerTurn
      // branch above, not a generic JSON-RPC-daemon dispatch yet.
      return new CodexSessionDriver(def, {
        homeOverride: options.homeOverride,
        initialSessionId: options.initialSessionId,
        host: options.host,
      });
    case "custom":
      throw new Error(`no session driver for exec.kind "custom" (def "${def.identity.id}")`);
  }
}
