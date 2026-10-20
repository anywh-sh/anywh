// What the host remembers about its agents across its own restarts: one JSON
// file, written atomically (temp file + rename) on every change that matters
// for bringing an agent back — never on every event.
//
// It holds each agent's spec, which can include the relay's bridge config,
// so the file is 0600 inside the host's 0700 data directory.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, "registry.json");
  }

  /**
   * Every persisted agent. A missing file is a fresh host. A file that is
   * there but cannot be parsed (a torn write, a hand edit) is moved aside to
   * `registry.json.corrupt-<time>` and the host starts empty — the logs are
   * kept either way. A file that cannot be READ (permissions, I/O error) is
   * an error: starting empty would overwrite every agent with nothing on
   * the next save, over what may be a transient problem.
   */
  load(): PersistedAgent[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`cannot read the agent registry ${this.path}: ${(error as Error).message}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const agents = typeof parsed === "object" && parsed !== null ? (parsed as Partial<RegistryFile>).agents : undefined;
    if (!Array.isArray(agents)) {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      renameSync(this.path, aside);
      console.error(`[agent-host] the agent registry could not be parsed; kept it as ${aside} and starting with no agents`);
      return [];
    }
    return agents.filter(
      (agent): agent is PersistedAgent =>
        typeof agent === "object" && agent !== null && typeof (agent as PersistedAgent).agentId === "string" && typeof (agent as PersistedAgent).spec === "object",
    );
  }

  /** Atomic and durable: the temp file is synced before the rename, and the
   * directory after it, so a crash leaves either the old or the new file. */
  save(agents: readonly PersistedAgent[]): void {
    const tmp = `${this.path}.tmp`;
    const file: RegistryFile = { version: 1, agents };
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(file));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    const dirFd = openSync(this.dataDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}
