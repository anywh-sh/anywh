import { spawn } from "node:child_process";
import { buildChildEnv } from "../../host/childEnv.js";
import { EXTRA_PATH_DIRS, resolveAgentBin } from "../executables.js";
import type { AgentRuntimeDef, ModelCatalog } from "../types.js";

const MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * The model catalog this runtime's CLI offers under this `$HOME`, exactly
 * as its own picker lists it — or `undefined` when it can't be read (probe
 * failed, timed out, or the def only knows it from inside a session).
 *
 * Same split as `probeRuntimeAuth`: the def owns which args, what to write
 * on stdin and how to read the answer (`models`), this file owns only the
 * process — the environment (credential stripping, `PATH` patch) and the
 * lifecycle. The child is killed as soon as `parse` recognizes an answer
 * rather than waiting for it to exit on its own: a request/response CLI
 * (Codex's app-server) never would while its stdin stays open, and one
 * that does (Claude after `initialize`) has nothing left worth waiting for.
 */
export function probeModelCatalog(def: AgentRuntimeDef, homeOverride: string | undefined, cwd: string): Promise<ModelCatalog | undefined> {
  const { models } = def;
  if (models.kind === "static") return Promise.resolve(models.catalog);
  if (models.kind === "session-rpc") return Promise.resolve(undefined);

  return new Promise((resolveCatalog) => {
    const stripCredentials = (env: NodeJS.ProcessEnv): void => {
      for (const name of def.identity.env.strip) delete env[name];
    };
    const child = spawn(resolveAgentBin(def.identity.bin), models.args, {
      cwd,
      env: buildChildEnv(homeOverride, EXTRA_PATH_DIRS, stripCredentials, def.identity.env.set),
    });
    let stdout = "";
    let settled = false;
    const settle = (catalog: ModelCatalog | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolveCatalog(catalog && catalog.options.length > 0 ? catalog : undefined);
    };
    const tryParse = (): ModelCatalog | undefined => {
      try {
        return models.parse(stdout);
      } catch {
        return undefined;
      }
    };
    const timeout = setTimeout(() => {
      console.warn(`[relay] ${def.identity.id} model catalog probe timed out`);
      settle(undefined);
    }, MODEL_PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const catalog = tryParse();
      if (catalog) settle(catalog);
    });
    // An EPIPE on a child that exited before reading its stdin is a failed
    // probe like any other, not an uncaught error taking the relay down.
    child.stdin?.on("error", () => {});
    child.on("error", () => settle(undefined));
    child.on("close", () => settle(tryParse()));
    if (models.stdin !== undefined) child.stdin?.write(models.stdin);
    else child.stdin?.end();
  });
}
