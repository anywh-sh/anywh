// A Claude Code process that runs no turn and answers control requests —
// the same stdin/stdout stream-json protocol a session's process speaks
// (`initialize`, `interrupt`, ...), used for what the CLI only tells from
// inside a running process: the state of every MCP server (`mcp_status`),
// and later calling a server's tool or signing in to one. No turn means no
// model call: nothing here spends the person's quota.
//
// Requests carry their own `request_id` and are answered out of order;
// each has its own timeout, and one that runs out stops the process (it
// is wedged; the next request starts a fresh one). `ClaudeControlPool`
// keeps a few of these alive, one per folder: a project's own servers
// (`.mcp.json`, local ones) only load with the process started there.
import { spawn } from "node:child_process";
import { buildChildEnv } from "../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../runtimes/executables.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";

export const CLAUDE_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
export const CLAUDE_CONTROL_IDLE_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 2000;

/** The CLI answered the request with an error. */
export class ClaudeControlError extends Error {
  constructor(
    readonly subtype: string,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeControlError";
  }
}

/** No answer in time; the process was stopped. */
export class ClaudeControlTimeout extends Error {
  constructor(subtype: string, ms: number) {
    super(`claude control: ${subtype} timed out after ${ms} ms`);
    this.name = "ClaudeControlTimeout";
  }
}

/** The process was gone (never started, crashed, or closed) before it
 * answered. */
export class ClaudeControlExited extends Error {
  constructor(detail: string) {
    super(`claude control: process exited (${detail})`);
    this.name = "ClaudeControlExited";
  }
}

export interface ClaudeControlOptions {
  readonly def: AgentRuntimeDef;
  /** The whole argv, the def's `processArgs` plus anything the caller adds
   * (an isolating `--mcp-config`). */
  readonly args: readonly string[];
  readonly cwd: string;
  /** The profile's `$HOME`; the relay's own when absent. */
  readonly homeOverride?: string;
  /** Every stdout message that is not a control response. */
  readonly onMessage?: (message: unknown) => void;
  readonly onExit?: () => void;
}

export interface ClaudeControlProcess {
  /** Sends `{subtype, ...payload}` and resolves with the reply's
   * `response`. Rejects with `ClaudeControlError`, `ClaudeControlTimeout`
   * or `ClaudeControlExited`. */
  request(subtype: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly exited: boolean;
  /** Ends the process. Idempotent. */
  close(): void;
  /** Ends the process once the requests it has are answered (at once with
   * none); it takes no new ones meanwhile. */
  closeWhenIdle(): void;
}

interface Pending {
  readonly subtype: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Spawns the process and starts the `initialize` handshake; requests sent
 * before it answers wait for it. */
export function startClaudeControl(options: ClaudeControlOptions): ClaudeControlProcess {
  const { def } = options;
  const child = spawn(resolveAgentBin(def.identity.bin), options.args, {
    cwd: options.cwd,
    env: buildChildEnv(
      options.homeOverride,
      EXTRA_PATH_DIRS,
      (env) => {
        for (const name of def.identity.env.strip) delete env[name];
      },
      def.identity.env.set,
    ),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let exited = false;
  let draining = false;
  // Requests asked and not answered yet, those still waiting for the
  // handshake included.
  let inFlight = 0;
  let stdout = "";

  const finish = (detail: string): void => {
    if (exited) return;
    exited = true;
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      pending.delete(id);
      waiting.reject(new ClaudeControlExited(detail));
    }
    options.onExit?.();
  };

  const close = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      // The CLI ends on stdin EOF; the signal is for one that doesn't.
      child.stdin.end();
      child.kill("SIGTERM");
      const escalate = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      escalate.unref();
      child.once("exit", () => clearTimeout(escalate));
    }
    finish("closed");
  };

  child.on("error", (error) => finish(error.message));
  child.on("exit", (code, signal) => finish(signal ?? `code ${code}`));
  // A write after the process died (EPIPE) is reported through `exit`.
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let newline: number;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(message) && message.type === "control_response" && isRecord(message.response)) {
        const reply = message.response;
        const waiting = typeof reply.request_id === "string" ? pending.get(reply.request_id) : undefined;
        if (!waiting) continue;
        pending.delete(reply.request_id as string);
        clearTimeout(waiting.timer);
        if (reply.subtype === "success") waiting.resolve(reply.response);
        else waiting.reject(new ClaudeControlError(waiting.subtype, typeof reply.error === "string" ? reply.error : "control request failed"));
        continue;
      }
      options.onMessage?.(message);
    }
  });

  const send = (subtype: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exited) {
        reject(new ClaudeControlExited("already exited"));
        return;
      }
      const id = `anywh-ctl-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ClaudeControlTimeout(subtype, timeoutMs));
        close();
      }, timeoutMs);
      pending.set(id, { subtype, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { ...payload, subtype } })}\n`);
    });

  const ready = send("initialize", {}, CLAUDE_CONTROL_REQUEST_TIMEOUT_MS * 3);
  // A failed handshake rejects every request through `ready`; this only
  // keeps the rejection from being reported as unhandled.
  ready.catch(() => {});

  return {
    async request(subtype, payload = {}, timeoutMs = CLAUDE_CONTROL_REQUEST_TIMEOUT_MS) {
      if (draining) throw new ClaudeControlExited("closing");
      inFlight += 1;
      try {
        await ready;
        return await send(subtype, payload, timeoutMs);
      } finally {
        inFlight -= 1;
        if (draining && inFlight === 0) close();
      }
    },
    get exited() {
      return exited;
    },
    close,
    closeWhenIdle() {
      draining = true;
      if (inFlight === 0) close();
    },
  };
}

/** The control-process argv the def declares, or `undefined` for a def
 * whose inventory is not read through control requests. */
export function claudeControlArgs(def: AgentRuntimeDef): readonly string[] | undefined {
  const { mcp } = def.portability;
  if (mcp.kind !== "supported" || mcp.inventory?.kind !== "control-request") return undefined;
  return mcp.inventory.processArgs;
}

export interface ClaudeControlPoolOptions {
  readonly def: AgentRuntimeDef;
  readonly homeOverride?: string;
  /** Where the process for the servers every session has runs: a folder
   * with no project servers of its own. */
  readonly neutralCwd: string;
  /** Project folders kept at once, besides the neutral one; the one used
   * least recently is stopped first. */
  readonly maxProjectProcesses?: number;
  readonly idleMs?: number;
  /** Defaults to `startClaudeControl`. */
  readonly start?: (options: ClaudeControlOptions) => ClaudeControlProcess;
  /** Messages of any pooled process that are not control responses. */
  readonly onMessage?: (cwd: string, message: unknown) => void;
}

interface Pooled {
  readonly process: ClaudeControlProcess;
  idle: NodeJS.Timeout;
  usedAt: number;
}

/** Control processes of one profile, one per folder: the neutral one plus
 * a few project folders. Each stops after `idleMs` without a request. */
export class ClaudeControlPool {
  private readonly processes = new Map<string, Pooled>();
  private readonly args: readonly string[];
  private readonly maxProjectProcesses: number;
  private readonly idleMs: number;
  private readonly start: (options: ClaudeControlOptions) => ClaudeControlProcess;
  private uses = 0;

  constructor(private readonly options: ClaudeControlPoolOptions) {
    const args = claudeControlArgs(options.def);
    if (!args) throw new Error(`claude control: def "${options.def.identity.id}" declares no control-request inventory`);
    this.args = args;
    this.maxProjectProcesses = options.maxProjectProcesses ?? 2;
    this.idleMs = options.idleMs ?? CLAUDE_CONTROL_IDLE_MS;
    this.start = options.start ?? startClaudeControl;
  }

  get neutralCwd(): string {
    return this.options.neutralCwd;
  }

  /** A request on the process of `cwd` (the neutral folder when absent).
   * `fresh` replaces a running process first: one started before a config
   * change still reports the servers it loaded then. The one replaced
   * still answers what it was asked before it ends. */
  request(cwd: string | undefined, subtype: string, payload?: Record<string, unknown>, options: { timeoutMs?: number; fresh?: boolean } = {}): Promise<unknown> {
    const key = cwd ?? this.options.neutralCwd;
    if (options.fresh) this.stop(key, true);
    return this.acquire(key).request(subtype, payload, options.timeoutMs);
  }

  /** Folders with a running process. */
  running(): string[] {
    return [...this.processes.keys()];
  }

  close(): void {
    for (const key of [...this.processes.keys()]) this.stop(key);
  }

  /** Every next request starts a new process (one that loads new tokens);
   * the running ones end once they answered what they were asked. */
  recycle(): void {
    for (const key of [...this.processes.keys()]) this.stop(key, true);
  }

  private acquire(key: string): ClaudeControlProcess {
    const existing = this.processes.get(key);
    if (existing && !existing.process.exited) {
      this.touch(key, existing);
      return existing.process;
    }
    if (existing) this.stop(key);
    if (key !== this.options.neutralCwd) this.evictFor();
    const started = this.start({
      def: this.options.def,
      args: this.args,
      cwd: key,
      homeOverride: this.options.homeOverride,
      onMessage: (message) => this.options.onMessage?.(key, message),
      onExit: () => {
        const current = this.processes.get(key);
        if (current?.process === started) {
          clearTimeout(current.idle);
          this.processes.delete(key);
        }
      },
    });
    const pooled: Pooled = { process: started, idle: this.idleTimer(key), usedAt: ++this.uses };
    this.processes.set(key, pooled);
    return started;
  }

  private touch(key: string, pooled: Pooled): void {
    clearTimeout(pooled.idle);
    pooled.idle = this.idleTimer(key);
    pooled.usedAt = ++this.uses;
  }

  private idleTimer(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.stop(key), this.idleMs);
    timer.unref();
    return timer;
  }

  private evictFor(): void {
    const projects = [...this.processes.entries()].filter(([key]) => key !== this.options.neutralCwd);
    if (projects.length < this.maxProjectProcesses) return;
    projects.sort(([, a], [, b]) => a.usedAt - b.usedAt);
    for (const [key] of projects.slice(0, projects.length - this.maxProjectProcesses + 1)) this.stop(key);
  }

  private stop(key: string, drain = false): void {
    const pooled = this.processes.get(key);
    if (!pooled) return;
    this.processes.delete(key);
    clearTimeout(pooled.idle);
    if (drain) pooled.process.closeWhenIdle();
    else pooled.process.close();
  }
}
