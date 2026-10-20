// The agent host as a real separate process (its own service entrypoint),
// for tests that run it next to a relay process. Every kill targets the exact
// pid this helper spawned.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_AGENT_BIN } from "./testServer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = resolve(HERE, "../..");
const HOST_ENTRY = resolve(RELAY_ROOT, "src/agentHost/main.ts");

export interface HostProcess {
  readonly dir: string;
  readonly home: string;
  readonly socketPath: string;
  readonly proc: ChildProcess;
  readonly output: string[];
  /** SIGTERM (a drain), then waits for the exit. */
  stop(): Promise<void>;
}

export function hostEnvDir(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "anywh-host-proc-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

export function startHostProcess(dir: string, home: string, extraEnv: Record<string, string> = {}): HostProcess {
  const socketPath = join(dir, "run", "host.sock");
  const output: string[] = [];
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", HOST_ENTRY, "--profile", "test", "--host-id", `t-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, "--socket", socketPath, "--data-dir", join(dir, "data")],
    {
      cwd: RELAY_ROOT,
      env: { ...process.env, ANYWH_AGENT_HOST_DRAIN_GRACE_MS: "500", ANYWH_AGENT_HOST_HIBERNATE: "off", RELAY_HOME_OVERRIDE: home, AGENT_BIN: FAKE_AGENT_BIN, ...extraEnv },
    },
  );
  proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return {
    dir,
    home,
    socketPath,
    proc,
    output,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
