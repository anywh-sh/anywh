import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCodexDaemon, type CodexDaemon } from "../transports/codexDaemon.js";
import { acpCatalog, acpConfigOptions, acpModelChoices, acpModelOption } from "../defs/acp.js";
import type { AgentRuntimeDef, ModelCatalog, ModelOption, TurnContext } from "../types.js";

const ACP_MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * The model catalog of an ACP agent (`models.kind: "session-rpc"`), read
 * the only way ACP offers it: a throwaway session's own `configOptions`.
 * The picker lists every model, but the reasoning levels only for the model
 * selected, and they differ per model — so each model is selected in turn
 * and its levels read back. Selecting a model is a setting, not a prompt:
 * nothing here spends the user's quota. The session is deleted afterwards
 * so it never shows in the agent's own history, and it lives in a temp dir
 * of its own, never the user's project.
 *
 * `undefined` when anything fails — a probe that can't answer leaves the
 * picker on the agent's default rather than guessing a list.
 */
export async function probeAcpModelCatalog(def: AgentRuntimeDef, homeOverride: string | undefined): Promise<ModelCatalog | undefined> {
  if (def.exec.kind !== "jsonRpcDaemon" || def.exec.protocol !== "acp") return undefined;
  const exec = def.exec;
  const cwd = mkdtempSync(join(tmpdir(), "anywh-acp-models-"));
  const abort = new AbortController();
  let daemon: CodexDaemon | undefined;
  const timeout = setTimeout(() => {
    console.warn(`[relay] ${def.identity.id} model catalog probe timed out`);
    abort.abort();
    daemon?.kill();
  }, ACP_MODEL_PROBE_TIMEOUT_MS);
  try {
    daemon = await spawnCodexDaemon({
      def,
      cwd,
      homeOverride,
      // A session that is never prompted asks nothing.
      host: { requestApproval: () => Promise.reject(new Error("probe")), requestUserInput: () => Promise.reject(new Error("probe")) },
      onNotification: () => {},
      onExit: () => {},
      initSignal: abort.signal,
    });
    const ctx: TurnContext = { cwd, prompt: "", permissionModeId: def.permissions.defaultModeId };
    const start = exec.thread.start(ctx);
    const created = await daemon.request(start.method, start.params);
    const sessionId = (created as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string") return undefined;
    const { models, defaultId } = acpModelChoices(acpConfigOptions(created));
    const options: ModelOption[] = [];
    try {
      for (const model of models) {
        const selected = await daemon.request("session/set_config_option", { sessionId, configId: modelConfigId(created), value: model.value });
        options.push(acpModelOption(model, acpConfigOptions(selected)));
      }
    } finally {
      await daemon.request("session/delete", { sessionId }).catch(() => undefined);
    }
    return options.length > 0 ? acpCatalog(options, defaultId) : undefined;
  } catch (error) {
    if (!abort.signal.aborted) console.warn(`[relay] ${def.identity.id} model catalog probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timeout);
    daemon?.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The id the agent gives its model picker (`category: "model"`). */
function modelConfigId(result: unknown): string {
  return acpConfigOptions(result).find((option) => option.category === "model")?.id ?? "model";
}
