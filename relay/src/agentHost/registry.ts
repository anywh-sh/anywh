// What the host remembers about its agents across its own restarts: one JSON
// file, written atomically (temp file + rename) on every change that matters
// for bringing an agent back — never on every event.
//
// It holds each agent's spec, which can include the relay's bridge config,
// so the file is 0600 inside the host's 0700 data directory.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeAgentSpec } from "./claudeProcess.js";
import type { AgentRuntimeId, StopReason } from "./protocol.js";

export type PersistedLifecycle = "starting" | "alive" | "hibernated" | "stopped" | "failed";

export interface PersistedAgent {
  readonly agentId: string;
  readonly runtime: AgentRuntimeId;
  readonly roomId?: string;
  readonly spec: ClaudeAgentSpec;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly lifecycle: PersistedLifecycle;
  readonly awaitingUser: boolean;
  readonly lastActivityAt: number;
  readonly lastTurnEndedAt?: number;
  readonly stopReason?: StopReason;
  readonly failure?: string;
}

interface RegistryFile {
  readonly version: 1;
  readonly agents: readonly PersistedAgent[];
}

export class AgentRegistry {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "registry.json");
  }

  /** Every persisted agent; nothing (not an error) when the file is missing
   * or unreadable — the logs on disk are kept either way. */
  load(): PersistedAgent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const agents = (parsed as Partial<RegistryFile>).agents;
    if (!Array.isArray(agents)) return [];
    return agents.filter(
      (agent): agent is PersistedAgent =>
        typeof agent === "object" && agent !== null && typeof (agent as PersistedAgent).agentId === "string" && typeof (agent as PersistedAgent).spec === "object",
    );
  }

  save(agents: readonly PersistedAgent[]): void {
    const tmp = `${this.path}.tmp`;
    const file: RegistryFile = { version: 1, agents };
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
