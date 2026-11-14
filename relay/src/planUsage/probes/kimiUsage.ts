// Pulls Kimi Code's plan usage from a `kimi web` server of its own: the CLI's
// local web server, which reads the quota with the CLI's own login, the same
// way Codex's plan usage comes from a `codex app-server` (codexRateLimits.ts).
// The relay never reads Kimi's credentials: it only checks that the CLI has
// some (the `credentials/` directory under its home exists and is not empty,
// never opened), so a profile without a login spawns nothing.
//
// `kimi web --no-open --port <p>` binds 127.0.0.1 only and prints a bearer
// token once it is ready; the reader keeps that one process up between reads
// (a start costs about a second) and retires it after `idleTimeoutMs`
// without a read, or on `close()`. Reading spends no quota: it asks Kimi's
// backend for the numbers, it starts no turn.
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "../../host/childEnv.js";
import { resolveRuntimeBin } from "../../runtimes/executables.js";
import { kimiRuntimeDef } from "../../runtimes/defs/kimi.js";
import type { AgentRuntimeDef } from "../../runtimes/types.js";
import type { PlanUsageReading } from "../ingest.js";
import { kimiWebToken, parseKimiUsage, parseKimiUserInfo } from "../kimiLimits.js";
import type { PlanUsageErrorKind, PlanUsageStatus } from "../types.js";

export const KIMI_START_TIMEOUT_MS = 20_000;
export const KIMI_REQUEST_TIMEOUT_MS = 10_000;
export const KIMI_IDLE_TIMEOUT_MS = 5 * 60_000;

export type KimiUsageResult =
  /** `userId` is for the account key only: never stored or logged. */
  | { kind: "reading"; reading: PlanUsageReading; userId?: string }
  | { kind: "auth"; status: Extract<PlanUsageStatus, "signed_out"> }
  | { kind: "error"; error: PlanUsageErrorKind };

export interface KimiUsageReader {
  /** Reads now. Never rejects. Concurrent calls share one read. */
  read(): Promise<KimiUsageResult>;
  /** Stops the server, if one is up. The next `read` starts a new one. */
  close(): void;
}

export interface KimiUsageReaderOptions {
  /** The profile's `$HOME` (`RELAY_HOME_OVERRIDE`); the relay's own when absent. */
  readonly homeOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The Kimi def; tests swap `identity.bin` for a fake server. */
  readonly def?: AgentRuntimeDef;
  readonly now?: () => number;
  readonly startTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/** Kimi's home for a profile: `$KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function kimiHomeDir(homeOverride: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIMI_CODE_HOME;
  if (override) return override;
  return join(homeOverride ?? env.HOME ?? homedir(), ".kimi-code");
}

/** Whether the CLI holds any login, by the presence of a file in its
 * credentials directory — listed, never read. */
export function kimiHasCredentials(home: string): boolean {
  try {
    return readdirSync(join(home, "credentials")).length > 0;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error("no free port"))));
    });
  });
}

interface Server {
  readonly child: ChildProcess;
  readonly base: string;
  readonly token: string;
}

export function createKimiUsageReader(options: KimiUsageReaderOptions = {}): KimiUsageReader {
  const env = options.env ?? process.env;
  const def = options.def ?? kimiRuntimeDef;
  const now = options.now ?? Date.now;
  const startTimeoutMs = options.startTimeoutMs ?? KIMI_START_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? KIMI_REQUEST_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? KIMI_IDLE_TIMEOUT_MS;
  let server: Promise<Server> | undefined;
  let inFlight: Promise<KimiUsageResult> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  /** The process behind `server`, so an old one exiting late never clears
   * a newer one. */
  let current: ChildProcess | undefined;

  function stop(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const pending = server;
    server = undefined;
    current = undefined;
    pending?.then((up) => up.child.kill(), () => undefined);
  }

  function start(): Promise<Server> {
    return freePort().then(
      (port) =>
        new Promise<Server>((resolveServer, reject) => {
          const stripCredentials = (childEnv: NodeJS.ProcessEnv): void => {
            for (const name of def.identity.env.strip) delete childEnv[name];
          };
          const child = spawn(resolveRuntimeBin(def.identity), ["web", "--no-open", "--port", String(port)], {
            cwd: tmpdir(),
            env: buildChildEnv(options.homeOverride, [], stripCredentials, def.identity.env.set),
            stdio: ["ignore", "pipe", "pipe"],
          });
          current = child;
          let stdout = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`kimi web did not start within ${startTimeoutMs} ms`));
          }, startTimeoutMs);
          const readToken = (chunk: Buffer): void => {
            stdout += chunk.toString("utf8");
            const token = kimiWebToken(stdout);
            if (!token) return;
            clearTimeout(timer);
            // Only the startup banner is of interest: the server can live for
            // hours, and keeping (and re-scanning) all it prints after that
            // would grow without bound. Still drained, so a full pipe never
            // blocks it.
            stdout = "";
            child.stdout?.off("data", readToken);
            child.stdout?.on("data", () => {});
            resolveServer({ child, base: `http://127.0.0.1:${port}`, token });
          };
          child.stdout?.on("data", readToken);
          child.stderr?.on("data", () => {});
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("kimi web exited before it was ready"));
            // A server that died after it was up is gone: the next read starts one.
            if (current === child) {
              current = undefined;
              server = undefined;
            }
          });
        }),
    );
  }

  async function get(up: Server, path: string): Promise<unknown> {
    const response = await fetch(`${up.base}${path}`, { headers: { authorization: `Bearer ${up.token}` }, signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) throw new Error(`kimi web ${path} answered ${response.status}`);
    return response.json();
  }

  async function readOnce(): Promise<KimiUsageResult> {
    if (!kimiHasCredentials(kimiHomeDir(options.homeOverride, env))) return { kind: "auth", status: "signed_out" };
    server ??= start();
    let up: Server;
    try {
      up = await server;
    } catch {
      server = undefined;
      return { kind: "error", error: "unknown" };
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleTimeoutMs);
    idleTimer.unref();
    let usageBody: unknown;
    let infoBody: unknown;
    try {
      [usageBody, infoBody] = await Promise.all([get(up, "/api/v1/oauth/usage"), get(up, "/api/v1/oauth/userinfo").catch(() => undefined)]);
    } catch {
      return { kind: "error", error: "network" };
    }
    const usage = parseKimiUsage(usageBody);
    if (usage.kind === "signed_out") return { kind: "auth", status: "signed_out" };
    if (usage.kind === "unrecognized") return { kind: "error", error: "parse" };
    const account = parseKimiUserInfo(infoBody);
    return {
      kind: "reading",
      reading: { status: usage.status, windows: usage.windows, observedAt: now(), source: "cli_server_read", ...(account.plan ? { plan: account.plan } : {}) },
      ...(account.userId ? { userId: account.userId } : {}),
    };
  }

  return {
    read() {
      inFlight ??= readOnce()
        .catch((): KimiUsageResult => ({ kind: "error", error: "unknown" }))
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    close: stop,
  };
}
