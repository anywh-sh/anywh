// "+ Add Jira": declares an integration's server in each agent CLI the
// person picked, through the CLI itself (the def's `mcp.add`: Claude's
// `mcp add-json`, Codex's `config/value/write`), then lists the servers to
// sign in to. A CLI that already has a server of the integration gets none
// added: its server is the one signed in.
import { spawn } from "node:child_process";
import { buildChildEnv } from "../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../runtimes/executables.js";
import type { AgentRuntimeDef, McpAddContract } from "../runtimes/types.js";
import type { IntegrationProvider, McpAuthTarget, McpInventoryEntry, McpRuntimeId } from "./types.js";

export const ADD_CLI_TIMEOUT_MS = 20_000;

/** The server an integration is added as, per provider: its name in the
 * CLI and its declaration in that CLI's terms. */
interface ProviderServer {
  readonly name: string;
  readonly fallbackName: string;
  readonly config: (runtimeId: McpRuntimeId) => Record<string, unknown>;
}

const ATLASSIAN_URL = "https://mcp.atlassian.com/v1/mcp";

const PROVIDER_SERVERS: Partial<Record<IntegrationProvider, ProviderServer>> = {
  jira: {
    name: "atlassian",
    fallbackName: "atlassian-anywh",
    config: (runtimeId) => (runtimeId === "claude" ? { type: "http", url: ATLASSIAN_URL } : { url: ATLASSIAN_URL }),
  },
};

/** The name a new server gets in a CLI: the provider's own, unless that CLI
 * has a server by that name already. `undefined` when both are taken. */
export function nameToAdd(provider: IntegrationProvider, taken: readonly string[]): string | undefined {
  const server = PROVIDER_SERVERS[provider];
  if (!server) return undefined;
  return [server.name, server.fallbackName].find((name) => !taken.includes(name));
}

export interface IntegrationAddDeps {
  readonly defs: readonly AgentRuntimeDef[];
  readonly homeOverride?: string;
  readonly neutralCwd: string;
  /** The CLI's server of the integration, if it has one. */
  readonly existing: (runtimeId: McpRuntimeId) => McpInventoryEntry | undefined;
  /** Every server name the CLI has. */
  readonly names: (runtimeId: McpRuntimeId) => string[];
  /** A request on the profile's Codex app-server. */
  readonly codexRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Rescans the CLI's servers; resolves once the inventory has them. */
  readonly rescan: (runtimeId: McpRuntimeId) => Promise<unknown>;
  /** The inventory's entry by name, after the rescan. */
  readonly entry: (runtimeId: McpRuntimeId, name: string) => McpInventoryEntry | undefined;
}

export interface IntegrationAddResult {
  /** The servers to sign in to, in the order asked. */
  readonly targets: McpAuthTarget[];
  /** Per CLI that could not get one, why. */
  readonly failures: { runtimeId: McpRuntimeId; error: string }[];
}

export async function addIntegration(deps: IntegrationAddDeps, provider: IntegrationProvider, runtimes: readonly McpRuntimeId[]): Promise<IntegrationAddResult> {
  const server = PROVIDER_SERVERS[provider];
  const result: IntegrationAddResult = { targets: [], failures: [] };
  for (const runtimeId of runtimes) {
    const existing = deps.existing(runtimeId);
    if (existing) {
      if (existing.status !== "connected") result.targets.push({ runtimeId, serverName: existing.name });
      continue;
    }
    const def = deps.defs.find((candidate) => candidate.identity.id === runtimeId);
    const contract = def?.portability.mcp.kind === "supported" ? def.portability.mcp.add : undefined;
    const name = nameToAdd(provider, deps.names(runtimeId));
    if (!server || !def || !contract || !name) {
      result.failures.push({ runtimeId, error: "unsupported" });
      continue;
    }
    try {
      await declare(deps, def, contract, name, server.config(runtimeId));
      await deps.rescan(runtimeId);
      if (deps.entry(runtimeId, name)?.status === "connected") continue;
      result.targets.push({ runtimeId, serverName: name });
    } catch (error) {
      result.failures.push({ runtimeId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function declare(deps: IntegrationAddDeps, def: AgentRuntimeDef, contract: McpAddContract, name: string, config: Record<string, unknown>): Promise<unknown> {
  if (contract.kind === "app-server") {
    if (!deps.codexRequest) return Promise.reject(new Error("no app-server to write the declaration with"));
    return deps.codexRequest(contract.method, contract.params(name, config));
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolveAgentBin(def.identity.bin), contract.args(name, config), {
      cwd: deps.neutralCwd,
      env: buildChildEnv(
        deps.homeOverride,
        EXTRA_PATH_DIRS,
        (env) => {
          for (const variable of def.identity.env.strip) delete env[variable];
        },
        def.identity.env.set,
      ),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), ADD_CLI_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").at(-1) || `the CLI exited with ${String(code)}`));
    });
  });
}
