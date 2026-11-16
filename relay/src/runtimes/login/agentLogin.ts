import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { buildChildEnv } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveRuntimeBin } from "../executables.js";
import { spawnCodexDaemon, type CodexDaemon, type SpawnCodexDaemonOptions } from "../transports/codexDaemon.js";
import type { AgentRuntimeDef, LoginFlow, LoginPrompt, TurnHost } from "../types.js";

/**
 * Drives one CLI's own account sign-in (`AgentRuntimeDef.auth.login`) for
 * the app, so a lapsed login is fixed from a dialog instead of a terminal on
 * the host.
 *
 * What travels here is what a remote terminal would carry, nothing more:
 * the CLI's prompt out, and — for a `cli-paste` flow — the code the person
 * pasted, written straight to the CLI's stdin. That code is never logged,
 * kept or echoed, and the credential the sign-in ends in is written by the
 * CLI into its own store; this file never sees it.
 */

export type AgentLoginEvent =
  /** The CLI's output as it arrives, ANSI stripped — what the dialog shows
   * if no prompt can be read off it. */
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "prompt"; readonly prompt: LoginPrompt; readonly input: "code" | "none" }
  /** A pasted code the CLI itself found malformed. The process goes on
   * waiting, so another code can be sent on the same login. */
  | { readonly type: "invalid-code"; readonly detail: string }
  /** A pasted code the CLI refused. The process is gone (one attempt per
   * process); a retry is a new login. `detail` is the CLI's own line. */
  | { readonly type: "rejected"; readonly detail?: string }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly detail?: string };

export interface AgentLoginSession {
  onEvent(listener: (event: AgentLoginEvent) => void): void;
  /** The pasted code, for a `cli-paste` flow once its prompt is out. Ignored
   * otherwise, and after the first one. */
  submitCode(code: string): void;
  /** Ends the login now: the child is killed, an RPC login is cancelled.
   * Idempotent, and silent — no event follows a cancel. */
  cancel(): void;
}

export interface StartAgentLoginOptions {
  readonly homeOverride: string | undefined;
  /** Seam for the daemon of an `rpc-device` flow; the real one by default. */
  readonly spawnDaemon?: (options: SpawnCodexDaemonOptions) => Promise<CodexDaemon>;
  /** How long a login may wait for the person before it is given up.
   * Longer than any expiry measured (Kimi's 1800 s). */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 35 * 60 * 1000;

// Every CLI measured (Claude Code on Linux and macOS, Kimi Code) runs
// `$BROWSER <url>` instead of its platform opener when the variable is set.
// `true` takes the URL and does nothing, so no page opens on the host — the
// app opens it on the person's own device.
const NO_BROWSER = "true";

// CSI sequences, OSC sequences (a hyperlink in a terminal-aware CLI) and the
// carriage returns a spinner leaves behind.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Last non-empty line of what a CLI printed — its own explanation of a
 * failure, for the dialog's detail line. */
function lastLine(output: string): string | undefined {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.at(-1);
}

// A login daemon starts no turn, so it never expects a server request.
const DECLINING_HOST: TurnHost = {
  requestApproval: (request) => Promise.resolve(request.safeDecisionId ?? "decline"),
  requestUserInput: () => Promise.resolve("deferred" as const),
};

export function startAgentLogin(def: AgentRuntimeDef, options: StartAgentLoginOptions): AgentLoginSession {
  const flow = def.auth.login;
  if (!flow) throw new Error(`runtime "${def.identity.id}" declares no login`);

  const listeners: ((event: AgentLoginEvent) => void)[] = [];
  let finished = false;
  const emit = (event: AgentLoginEvent): void => {
    if (finished) return;
    if (event.type === "rejected" || event.type === "succeeded" || event.type === "failed") finished = true;
    for (const listener of listeners) listener(event);
  };

  const driver = flow.kind === "rpc-device" ? startRpcLogin(def, flow, options, emit) : startCliLogin(def, flow, options, emit);

  const timeout = setTimeout(() => {
    emit({ type: "failed", detail: "the sign-in timed out" });
    driver.stop();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref();

  return {
    onEvent: (listener) => listeners.push(listener),
    submitCode: (code) => driver.submitCode(code),
    cancel: () => {
      clearTimeout(timeout);
      finished = true;
      driver.stop();
    },
  };
}

interface LoginDriver {
  submitCode(code: string): void;
  stop(): void;
}

function startCliLogin(
  def: AgentRuntimeDef,
  flow: Extract<LoginFlow, { kind: "cli-paste" | "cli-device" }>,
  options: StartAgentLoginOptions,
  emit: (event: AgentLoginEvent) => void,
): LoginDriver {
  const stripCredentials = (env: NodeJS.ProcessEnv): void => {
    for (const name of def.identity.env.strip) delete env[name];
  };
  const env = buildChildEnv(options.homeOverride, EXTRA_PATH_DIRS, stripCredentials, { ...def.identity.env.set, BROWSER: NO_BROWSER });
  const child = spawn(resolveRuntimeBin(def.identity), [...flow.args], {
    cwd: options.homeOverride ?? homedir(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  // What the CLI printed since the last code went in.
  let sinceCode = "";
  let prompted = false;
  let codeSent = false;
  let stopped = false;

  const onChunk = (chunk: Buffer): void => {
    const text = stripTerminalCodes(chunk.toString("utf8"));
    output += text;
    emit({ type: "output", data: text });
    if (codeSent && flow.parseInvalidCode) {
      sinceCode += text;
      const invalid = flow.parseInvalidCode(sinceCode);
      if (invalid !== undefined) {
        codeSent = false;
        sinceCode = "";
        emit({ type: "invalid-code", detail: invalid });
        return;
      }
    }
    if (prompted) return;
    const prompt = flow.parsePrompt(output);
    if (!prompt) return;
    prompted = true;
    emit({ type: "prompt", prompt, input: flow.kind === "cli-paste" ? "code" : "none" });
  };
  // Both streams: a CLI that prints its prompt on stderr would otherwise
  // look like it hung.
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.stdin.on("error", () => {
    // The CLI exiting before reading stdin is reported by `close`.
  });

  child.on("error", (error) => {
    if (stopped) return;
    emit({ type: "failed", detail: error.message });
  });
  child.on("close", (code) => {
    if (stopped) return;
    if (code === 0) emit({ type: "succeeded" });
    else if (codeSent) emit({ type: "rejected", detail: lastLine(output) });
    else emit({ type: "failed", detail: lastLine(output) });
  });

  return {
    submitCode: (code) => {
      if (flow.kind !== "cli-paste" || !prompted || codeSent) return;
      const value = code.trim();
      if (value.length === 0) return;
      codeSent = true;
      sinceCode = "";
      child.stdin.write(`${value}\n`);
    },
    stop: () => {
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

function startRpcLogin(
  def: AgentRuntimeDef,
  flow: Extract<LoginFlow, { kind: "rpc-device" }>,
  options: StartAgentLoginOptions,
  emit: (event: AgentLoginEvent) => void,
): LoginDriver {
  const spawnDaemon = options.spawnDaemon ?? spawnCodexDaemon;
  let daemon: CodexDaemon | undefined;
  let loginId: string | undefined;
  let stopped = false;
  const initAbort = new AbortController();

  const end = (): void => {
    daemon?.kill();
  };

  spawnDaemon({
    def,
    cwd: options.homeOverride ?? homedir(),
    homeOverride: options.homeOverride,
    host: DECLINING_HOST,
    // Waiting on the person is not idleness: the timeout below owns this.
    idleTimeoutMs: (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 60_000,
    onNotification: (method, params) => {
      if (method !== flow.completedMethod) return;
      const completed = flow.parseCompleted(params);
      if (!completed) return;
      // `loginId` may be null in the real shape; one login per daemon, so
      // a null id can only be ours.
      if (completed.loginId !== null && loginId !== undefined && completed.loginId !== loginId) return;
      if (stopped) return;
      emit(completed.success ? { type: "succeeded" } : { type: "failed", detail: completed.error });
      end();
    },
    onExit: () => {
      if (stopped) return;
      emit({ type: "failed", detail: "the sign-in process exited" });
    },
    initSignal: initAbort.signal,
  }).then(
    async (started) => {
      daemon = started;
      if (stopped) return end();
      try {
        const result = await started.request(flow.start.method, flow.start.params);
        const parsed = flow.parseStart(result);
        if (!parsed) throw new Error("unexpected sign-in reply");
        loginId = parsed.loginId;
        if (stopped) return end();
        emit({ type: "prompt", prompt: parsed.prompt, input: "none" });
      } catch (error) {
        if (stopped) return;
        emit({ type: "failed", detail: error instanceof Error ? error.message : String(error) });
        end();
      }
    },
    (error: unknown) => {
      if (stopped) return;
      emit({ type: "failed", detail: error instanceof Error ? error.message : String(error) });
    },
  );

  return {
    submitCode: () => {},
    stop: () => {
      if (stopped) return;
      stopped = true;
      initAbort.abort();
      if (!daemon) return;
      const running = daemon;
      if (loginId === undefined) return running.kill();
      const cancel = flow.cancel(loginId);
      // Best effort: the process is going away either way.
      void running.request(cancel.method, cancel.params).catch(() => {}).finally(() => running.kill());
    },
  };
}
