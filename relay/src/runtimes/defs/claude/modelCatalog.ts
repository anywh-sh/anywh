import type { ModelCatalog, ModelOption } from "../../types.js";

/** One entry of the control protocol's `initialize` reply (`models`), the
 * fields this reads — shape measured against Claude Code 2.1.284. */
interface ClaudeModelInfo {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  resolvedModel?: unknown;
}

/**
 * Reads the `control_response` to `initialize` out of stream-json stdout.
 * `undefined` until that line has arrived whole (the probe engine calls
 * this on every chunk).
 *
 * The CLI lists a leading `default` pseudo-entry ("Default (recommended)",
 * whose `description` names the real model) ahead of the concrete ones.
 * It's dropped as an option — a session with no explicit pick already *is*
 * that — and turned into `defaultId` instead: the first concrete entry
 * resolving to the same underlying model (`opus` when the default is
 * `claude-opus-5-5`), so the picker can show "Opus 5.5" rather than a
 * word that says nothing about which model or version runs.
 */
export function parseClaudeModelCatalog(stdout: string): ModelCatalog | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"control_response"')) continue;
    let parsed: { type?: unknown; response?: { response?: { models?: unknown } } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "control_response") continue;
    const models = parsed.response?.response?.models;
    if (!Array.isArray(models)) continue;

    const entries = (models as ClaudeModelInfo[]).filter(
      (entry): entry is ClaudeModelInfo & { value: string; displayName: string } =>
        typeof entry.value === "string" && entry.value.length > 0 && typeof entry.displayName === "string",
    );
    const defaultEntry = entries.find((entry) => entry.value === "default");
    const concrete = entries.filter((entry) => entry !== defaultEntry);
    const options: ModelOption[] = concrete.map((entry) => ({
      id: entry.value,
      label: entry.displayName,
      ...(typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {}),
    }));
    const defaultId =
      typeof defaultEntry?.resolvedModel === "string"
        ? concrete.find((entry) => entry.resolvedModel === defaultEntry.resolvedModel)?.value
        : undefined;
    return { options, ...(defaultId ? { defaultId } : {}) };
  }
  return undefined;
}
