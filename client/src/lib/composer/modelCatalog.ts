import type { ModelCatalog, ModelChoice } from "@/lib/relay/relay-types";

/** Every installed agent's model catalog, from the most recent
 * `model_catalogs_state` seen from ANY profile's relay connection
 * (`relayClient.ts`) — keyed by agent id, each list exactly as that agent's
 * own CLI picker shows it (the relay's `probes/modelCatalog.ts`, driven by
 * each runtime def's `models`). Not scoped per profile, same call the
 * previous Claude-only catalog made: it's a CLI-version catalog, not an
 * account entitlement list. A plain module cache (not React state) because
 * `ProfileSettings` reads it outside any one session; a session's own
 * composer gets its agent's catalog as a prop instead (`useRelayClient`),
 * so it re-renders when the catalog lands. */
let cachedCatalogs: Record<string, ModelCatalog> = {};

export function recordModelCatalogs(catalogs: Record<string, ModelCatalog>): void {
  cachedCatalogs = { ...cachedCatalogs, ...catalogs };
}

export function getModelCatalogs(): Record<string, ModelCatalog> {
  return cachedCatalogs;
}

/** The agent's own display name for `model` ("Opus 5.5", "GPT-5.5") — the
 * raw id when the catalog doesn't list it (typed by hand, or picked before a
 * CLI update dropped it), never a label this app made up. */
export function labelForModel(catalog: ModelCatalog | null | undefined, model: ModelChoice): string {
  return catalog?.options.find((option) => option.id === model)?.label ?? model;
}

/** What a session is actually on: its explicit pick, or else the catalog's
 * own default — the CLI's answer to "no model chosen", not a guess. */
export function effectiveModel(catalog: ModelCatalog | null | undefined, model: ModelChoice | null): ModelChoice | null {
  return model ?? catalog?.defaultId ?? null;
}

export function catalogHasModel(catalog: ModelCatalog | null | undefined, model: ModelChoice): boolean {
  return catalog?.options.some((option) => option.id === model) ?? false;
}
