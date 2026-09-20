import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import pty from "node-pty";
import { listDeclaredServers, parseDeclaration } from "./declaration.js";
import { buildChildEnv } from "../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../runtimes/executables.js";
import type { AgentRuntimeDef } from "../runtimes/types.js";

// MCP sign-in, the half of a carried setup that cannot be carried: the
// servers travel as declarations, the sessions that authenticate them are
// re-earned where they land. This file answers which ones need that, and
// drives the CLI's own `mcp login` when the user asks for it — the same
// posture as the account login (`journal` of this project's design, and
// `runtimes/probes/runtimeAuth.ts` right next door): we drive the
// terminal, we never hold the secret.

export interface McpServerAuthState {
  readonly name: string;
  /** `true` only when the runtime says so out of band. A runtime that
   * reports authentication in band can't be asked ahead of time, so every
   * server reads `false` there — "unknown", not "fine", which is what
   * `signal` tells the UI to say. */
  readonly needsAuth: boolean;
}

export interface McpAuthStatus {
  readonly runtimeId: string;
  /** `false` for a runtime with no MCP contract at all; the rest of the
   * fields are then empty rather than absent, so a client doesn't branch. */
  readonly supported: boolean;
  readonly signal: "file" | "in-band" | "none";
  readonly loginDriver: "pty" | "child" | "none";
  readonly servers: readonly McpServerAuthState[];
}

/** Which MCP servers this config home declares, and which of them the
 * runtime says need signing in. Never throws: a missing declaration file,
 * a missing signal file and a malformed one all read as "nothing to
 * report", which is what they mean. */
export function readMcpAuthStatus(def: AgentRuntimeDef, home: string): McpAuthStatus {
  const { mcp } = def.portability;
  if (mcp.kind === "none") {
    return { runtimeId: def.identity.id, supported: false, signal: "none", loginDriver: "none", servers: [] };
  }

  const { declaration, needsAuthSignal } = mcp;
  let declared: string[] = [];
  try {
    const text = readFileSync(join(home, declaration.path.split("/").join(sep)), "utf8");
    declared = listDeclaredServers(parseDeclaration(text, declaration.format), declaration.serversKey);
  } catch {
    // No declaration file: a home where no server was ever added.
  }

  let needing: readonly string[] = [];
  if (needsAuthSignal.kind === "file") {
    try {
      needing = needsAuthSignal.parse(readFileSync(join(home, needsAuthSignal.path.split("/").join(sep)), "utf8"));
    } catch {
      // The file only exists once the CLI has had a reason to write it.
    }
  }

  return {
    runtimeId: def.identity.id,
    supported: true,
    signal: needsAuthSignal.kind,
    loginDriver: mcp.loginDriver,
    // Declared order, not signal order: this list is what the UI shows,
    // and it should read the same whether or not anything needs auth
    // today. A server named only by the signal (declared elsewhere, or
    // removed since) is appended rather than dropped — it is still a
    // server the user is being asked to sign in to.
    servers: [
      ...declared.map((name) => ({ name, needsAuth: needing.includes(name) })),
      ...needing.filter((name) => !declared.includes(name)).map((name) => ({ name, needsAuth: true })),
    ],
  };
}

export interface McpLoginSession {
  /** Whatever the CLI printed, forwarded as it arrives — with
   * `--no-browser` this is where the authorization URL shows up. */
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  /** What the user types back: the redirect URL the browser landed on. It
   * goes straight to the CLI's own stdin and is never read, stored or
   * logged here. */
  write(data: string): void;
  kill(): void;
}

/**
 * Runs `<cli> mcp login <server>` against one config home.
 *
 * The def decides both halves: `loginArgs` builds the argv (Claude's
 * carries `--no-browser`, which is what makes a headless machine able to
 * finish at all), and `loginDriver` decides the mechanism. That second one
 * is not a preference — Claude Code refuses outright without a terminal
 * ("stdin isn't a terminal, so authentication can't be completed here")
 * while Codex completes the same flow as an ordinary child process. A pty
 * would technically satisfy both, but driving a CLI through a mechanism it
 * doesn't need is how a def's declaration quietly stops being checked.
 */
export function startMcpLogin(def: AgentRuntimeDef, home: string, serverName: string): McpLoginSession {
  const { mcp } = def.portability;
  if (mcp.kind !== "supported") throw new Error(`runtime "${def.identity.id}" declares no MCP support`);

  const bin = resolveAgentBin(def.identity.bin);
  const args = [...mcp.loginArgs(serverName)];
  const stripCredentials = (env: NodeJS.ProcessEnv): void => {
    for (const name of def.identity.env.strip) delete env[name];
  };
  const env = buildChildEnv(home, EXTRA_PATH_DIRS, stripCredentials, def.identity.env.set);

  if (mcp.loginDriver === "pty") {
    // 100x30 rather than a real terminal's size: nothing renders this, and
    // a too-narrow pty makes a CLI wrap the authorization URL across lines,
    // which is exactly the string the user has to copy intact.
    const child = pty.spawn(bin, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: home, env });
    return {
      onData: (listener) => {
        child.onData(listener);
      },
      onExit: (listener) => {
        child.onExit(({ exitCode }) => listener(exitCode));
      },
      write: (data) => child.write(data),
      kill: () => child.kill(),
    };
  }

  const child = spawn(bin, args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const dataListeners: ((chunk: string) => void)[] = [];
  const forward = (chunk: Buffer): void => {
    for (const listener of dataListeners) listener(chunk.toString("utf8"));
  };
  // Both streams, merged: the CLI measured for this driver prints its
  // prompts on stderr and would otherwise look like it hung.
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  return {
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => {
      child.on("close", (code) => listener(code));
      child.on("error", () => listener(null));
    },
    write: (data) => child.stdin.write(data),
    kill: () => child.kill(),
  };
}
