// One long-lived `claude` process: spawn, stdin writes, stdout lines, and
// ending it without leaving any of its tools' processes behind.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { buildChildEnv } from "../host/childEnv.js";
import { EXTRA_PATH_DIRS, stripBilledCredentials } from "../runtimes/executables.js";
import {
  buildPersistentArgs,
  encodeInterrupt,
  encodeUserMessage,
  persistentEnvOverrides,
  writePersistentMcpConfig,
  type AgentWorkerMcpFile,
  type PersistentClaudeSpec,
} from "../runtimes/defs/claude/index.js";
import { AGENT_ID_ENV, HOST_ID_ENV, signal, sweepAgentProcesses } from "./processTree.js";

export interface ClaudeAgentSpec extends PersistentClaudeSpec {
  readonly cwd: string;
  /** The relay's bridge servers (`--mcp-config` JSON), if any. */
  readonly mcpConfigJson?: string;
  /** Extra environment for this agent (e.g. subagent limits). Billed
   * credentials are stripped from it like from everything else. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ClaudeProcessOptions {
  readonly hostId: string;
  readonly agentId: string;
  readonly bin: string;
  readonly homeOverride?: string;
  /** Home used to find the user's MCP servers for an agent worker. */
  readonly home: string;
  readonly spec: ClaudeAgentSpec;
  readonly resumeSessionId?: string;
  readonly stderrPath: string;
  readonly onLine: (line: string) => void;
}

const STDERR_TAIL_BYTES = 4096;
const STDERR_FILE_CAP_BYTES = 1024 * 1024;

export class ClaudeProcess {
  readonly exited: Promise<ExitInfo>;
  private exitInfo: ExitInfo | undefined;
  private stderrTailText = "";
  private stderrFile: WriteStream | undefined;
  private stderrWritten = 0;
  private interruptCount = 0;

  private constructor(
    private readonly options: ClaudeProcessOptions,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly mcpFile: AgentWorkerMcpFile | undefined,
  ) {
    this.stderrFile = createWriteStream(options.stderrPath, { flags: "a", mode: 0o600 });
    this.stderrFile.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.trim()) options.onLine(line);
    });
    let resolveExit!: (info: ExitInfo) => void;
    this.exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    // `close`, not `exit`: by then stdout has been read to the end, so no
    // line can arrive after the exit is reported.
    child.on("close", (code, sig) => {
      this.exitInfo = { code, signal: sig };
      this.stderrFile?.end();
      this.stderrFile = undefined;
      void this.mcpFile?.remove().catch(() => {});
      resolveExit(this.exitInfo);
    });
  }

  /** Spawns the process in its own session and process group. Rejects if
   * the binary cannot be started at all. */
  static async spawn(options: ClaudeProcessOptions): Promise<ClaudeProcess> {
    const { spec } = options;
    const mcpFile = await writePersistentMcpConfig(spec.mcpConfigJson, spec.agentWorker, options.home, spec.cwd);
    const args = buildPersistentArgs(spec, { mcpConfigPath: mcpFile?.path, resumeSessionId: options.resumeSessionId });
    const env = buildChildEnv(options.homeOverride, EXTRA_PATH_DIRS, stripBilledCredentials, {
      ...persistentEnvOverrides(spec.agentWorker),
      ...(spec.env ?? {}),
      [HOST_ID_ENV]: options.hostId,
      [AGENT_ID_ENV]: options.agentId,
    });
    // `spec.env` is applied after the strip above; strip again so a caller
    // cannot hand a billed credential back in.
    stripBilledCredentials(env);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.bin, args, { cwd: spec.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      await mcpFile?.remove();
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        void mcpFile?.remove();
        reject(error);
      });
    });
    return new ClaudeProcess(options, child, mcpFile);
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  get stderrTail(): string {
    return this.stderrTailText.trim();
  }

  private onStderr(chunk: Buffer): void {
    const text = chunk.toString();
    this.stderrTailText = (this.stderrTailText + text).slice(-STDERR_TAIL_BYTES);
    if (this.stderrFile && this.stderrWritten < STDERR_FILE_CAP_BYTES) {
      this.stderrFile.write(chunk);
      this.stderrWritten += chunk.length;
    }
  }

  writeUserMessage(text: string): void {
    this.child.stdin.write(encodeUserMessage(text));
  }

  writeInterrupt(): void {
    this.interruptCount++;
    this.child.stdin.write(encodeInterrupt(`anywh-interrupt-${this.interruptCount}`));
  }

  /** Closing stdin with no turn in flight makes the CLI exit on its own. */
  endInput(): void {
    this.child.stdin.end();
  }

  private async waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exitInfo) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = await Promise.race([this.exited.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return done;
  }

  /**
   * Ends the process and everything it started. SIGTERM to the process and
   * its group first (the CLI cleans up its tools' processes on SIGTERM),
   * then SIGKILL to the group after `graceMs`, then a sweep for any process
   * of this agent that lives outside the group. Resolves with whether the
   * process exited within the grace period.
   */
  async terminate(graceMs: number): Promise<{ graceful: boolean; swept: number }> {
    const pid = this.pid;
    let graceful = true;
    if (!this.exitInfo && pid > 0) {
      signal(pid, "SIGTERM");
      signal(-pid, "SIGTERM");
      graceful = await this.waitExit(graceMs);
      if (!graceful) {
        signal(-pid, "SIGKILL");
        signal(pid, "SIGKILL");
        await this.waitExit(5000);
      }
    }
    // Whatever survived in the group (the leader is gone), then whatever
    // left the group.
    if (pid > 0) signal(-pid, "SIGKILL");
    const swept = await sweepAgentProcesses(this.options.hostId, this.options.agentId, Math.min(graceMs, 2000));
    return { graceful, swept };
  }

  /** Waits for the process to exit by itself (after `endInput`); if it has
   * not within `graceMs`, ends it like `terminate`. */
  async finish(graceMs: number): Promise<void> {
    if (!(await this.waitExit(graceMs))) {
      await this.terminate(graceMs);
      return;
    }
    if (this.pid > 0) signal(-this.pid, "SIGKILL");
    await sweepAgentProcesses(this.options.hostId, this.options.agentId, Math.min(graceMs, 2000));
  }
}
