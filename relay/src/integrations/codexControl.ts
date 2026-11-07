// The profile's own `codex app-server` for MCP: one daemon, kept alive
// between uses, holding one long-lived ephemeral thread. The app-server
// only reports a server's live state, and only calls its tools, on a
// thread (`threadId` is mandatory on the call; a `thread/start` starts the
// thread's servers), so one is started lazily and reused — recreated when
// the app-server says it no longer knows it, or after a restart. Nothing
// here runs a turn: listing servers and calling their tools spends no
// quota, and needs no Codex login.
//
// Same transport as the sessions and the plan usage reader
// (`spawnCodexDaemon`), but its own process: the plan usage reader only
// starts one when Codex is logged in, and stops it when nobody watches the
// Usage view, neither of which fits here.
import { tmpdir } from "node:os";
import { codexRuntimeDef } from "../runtimes/defs/codex.js";
import { spawnCodexDaemon, type CodexDaemon, type SpawnCodexDaemonOptions } from "../runtimes/transports/codexDaemon.js";
import { JsonRpcRemoteError } from "../runtimes/transports/jsonRpcStdio.js";
import type { AgentRuntimeDef, TurnHost } from "../runtimes/types.js";

export const CODEX_CONTROL_INIT_TIMEOUT_MS = 30_000;
export const CODEX_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
export const CODEX_CONTROL_IDLE_MS = 5 * 60 * 1000;

export class CodexControlTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`codex control: ${what} timed out after ${ms} ms`);
    this.name = "CodexControlTimeout";
  }
}

export interface CodexControlOptions {
  readonly def?: AgentRuntimeDef;
  /** The profile's `$HOME`; the relay's own when absent. */
  readonly homeOverride?: string;
  /** The daemon's and the thread's cwd: a folder with no project config. */
  readonly cwd?: string;
  /** Every notification the daemon pushes (`mcpServer/startupStatus/updated`
   * among them). */
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly initTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Defaults to `spawnCodexDaemon`. */
  readonly spawnDaemon?: (options: SpawnCodexDaemonOptions) => Promise<CodexDaemon>;
}

export interface CodexControl {
  /** A request that does not need the thread. */
  request(method: string, params: unknown): Promise<unknown>;
  /** A request on the shared thread: `params(threadId)` builds it. A
   * "thread not found" answer starts a new thread and tries once more. */
  requestOnThread(method: string, params: (threadId: string) => unknown): Promise<unknown>;
  /** `mcpServer/tool/call` on the shared thread; the raw MCP
   * `CallToolResult`. */
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Re-reads the MCP config in the running daemon (after a config change
   * or a sign-in). A no-op without a daemon. */
  reload(): Promise<void>;
  /** Whether a daemon is running now. */
  readonly running: boolean;
  close(): void;
}

/** It starts no turn, so no server request is expected; one is declined. */
export const DECLINING_HOST: TurnHost = {
  requestApproval: (request) => Promise.resolve(request.safeDecisionId ?? "decline"),
  requestUserInput: () => Promise.resolve("deferred" as const),
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexControlTimeout(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const isThreadGone = (error: unknown): boolean => error instanceof JsonRpcRemoteError && /thread not found|invalid thread id/i.test(error.message);

export function createCodexControl(options: CodexControlOptions = {}): CodexControl {
  const def = options.def ?? codexRuntimeDef;
  const cwd = options.cwd ?? tmpdir();
  const spawnDaemon = options.spawnDaemon ?? spawnCodexDaemon;
  const initTimeoutMs = options.initTimeoutMs ?? CODEX_CONTROL_INIT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? CODEX_CONTROL_REQUEST_TIMEOUT_MS;

  let daemon: CodexDaemon | undefined;
  let starting: Promise<CodexDaemon> | undefined;
  let thread: { daemon: CodexDaemon; id: Promise<string> } | undefined;
  // Bumped by `close()`: a spawn that resolves afterwards is stopped at once.
  let generation = 0;

  function ensureDaemon(): Promise<CodexDaemon> {
    if (daemon && !daemon.exited) return Promise.resolve(daemon);
    if (starting) return starting;
    const mine = generation;
    const abortInit = new AbortController();
    const spawned = spawnDaemon({
      def,
      cwd,
      homeOverride: options.homeOverride,
      host: DECLINING_HOST,
      onNotification: (method, params) => options.onNotification?.(method, params),
      onExit: () => {
        daemon = undefined;
        thread = undefined;
      },
      idleTimeoutMs: options.idleTimeoutMs ?? CODEX_CONTROL_IDLE_MS,
      initSignal: abortInit.signal,
    });
    let abandoned = false;
    void spawned.then(
      (started) => {
        if (abandoned || mine !== generation) started.kill();
      },
      () => {},
    );
    starting = withTimeout(spawned, initTimeoutMs, "initialize").then(
      (started) => {
        starting = undefined;
        if (mine !== generation) throw new Error("codex control: closed while starting");
        daemon = started;
        return started;
      },
      (error: unknown) => {
        abandoned = true;
        starting = undefined;
        abortInit.abort();
        throw error;
      },
    );
    return starting;
  }

  function stop(): void {
    generation++;
    starting = undefined;
    thread = undefined;
    daemon?.kill();
    daemon = undefined;
  }

  async function send(target: CodexDaemon, method: string, params: unknown): Promise<unknown> {
    try {
      return await withTimeout(target.request(method, params), requestTimeoutMs, method);
    } catch (error) {
      // A request that never answers means a wedged app-server: start over.
      if (error instanceof CodexControlTimeout && daemon === target) stop();
      throw error;
    }
  }

  function threadOf(target: CodexDaemon): Promise<string> {
    if (thread?.daemon === target) return thread.id;
    const id = send(target, "thread/start", { ephemeral: true, cwd, sandbox: "read-only", approvalPolicy: "never" }).then((result) => {
      const threadId = (result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
      if (typeof threadId !== "string") throw new Error("codex control: thread/start returned no thread id");
      return threadId;
    });
    const current = { daemon: target, id };
    thread = current;
    id.catch(() => {
      if (thread === current) thread = undefined;
    });
    return id;
  }

  async function requestOnThread(method: string, params: (threadId: string) => unknown): Promise<unknown> {
    const target = await ensureDaemon();
    const threadId = await threadOf(target);
    try {
      return await send(target, method, params(threadId));
    } catch (error) {
      if (!isThreadGone(error)) throw error;
      if (thread?.daemon === target) thread = undefined;
      return send(target, method, params(await threadOf(target)));
    }
  }

  return {
    async request(method, params) {
      return send(await ensureDaemon(), method, params);
    },
    requestOnThread,
    callTool(server, tool, args) {
      return requestOnThread("mcpServer/tool/call", (threadId) => ({ threadId, server, tool, arguments: args }));
    },
    async reload() {
      if (!daemon || daemon.exited) return;
      await send(daemon, "config/mcpServer/reload", {});
    },
    get running() {
      return daemon !== undefined && !daemon.exited;
    },
    close: stop,
  };
}
