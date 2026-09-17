import type { ModelChoice } from "@/lib/relay/relay-types";

/** Snapshot of the catalog before this session ever detected the CLI wasn't
 * around: cold start, or `SettingsDialog` opened before any profile ever
 * connected. Matches the CLI version this list was last curated against —
 * kept only as a fallback, `recordAvailableModels` below replaces it as soon
 * as any relay connection reports the real one back. */
const FALLBACK_MODELS: ModelChoice[] = ["sonnet", "opus", "haiku", "fable"];

/** Curated labels for the aliases we know about — anything else (a new
 * alias the CLI ships later, or a full model ID) falls back to showing the
 * raw value as-is instead of needing a code change first. Product names
 * only: `default` and `best` are words, not names, so they come from the
 * caller's dictionary instead (see `labelForModel`). */
const KNOWN_LABELS: Record<string, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
  fable: "Fable",
  opusplan: "Opus Plan",
  "sonnet[1m]": "Sonnet (1M)",
  "opus[1m]": "Opus (1M)",
  "fable[1m]": "Fable (1M)",
};

/** Populated from the most recent `default_model_state` seen from ANY
 * profile's relay connection (`relayClient.ts`) — not scoped per profile:
 * tested both accounts (Sonnet-5 default and Opus-5 default) and the
 * available-aliases list came back identical, so it's a CLI-version
 * catalog, not an account entitlement list. A plain module cache (not React
 * state) is enough here — `SettingsDialog` and `ModelButton` just read it at
 * render time, same pattern as `getPreferredModel`/`getDefaultPath`. */
let cachedModels: ModelChoice[] | null = null;

export function recordAvailableModels(models: ModelChoice[]): void {
  if (models.length === 0) return;
  cachedModels = models;
}

/** Every model the CLI currently accepts, excluding "default" — that's a
 * "no explicit override" meta-value, never a valid manual/fixed choice (see
 * `FixedModelChoice`). Falls back to `FALLBACK_MODELS` before any connection
 * has reported the real catalog back. */
export function getKnownModels(): ModelChoice[] {
  return (cachedModels ?? FALLBACK_MODELS).filter((model) => model !== "default");
}

/** `aliases` carries the copy for the two aliases that are prose rather than
 * a product name. Passed in rather than imported so this module stays free of
 * React — it's read at render time from three different components. */
export function labelForModel(model: ModelChoice, aliases: { default: string; best: string }): string {
  if (model === "default") return aliases.default;
  if (model === "best") return aliases.best;
  return KNOWN_LABELS[model] ?? model;
}
