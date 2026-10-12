import type { Dictionary } from "@/i18n/dictionary";
import type { EffortOption, ModelCatalog, ModelChoice, ModelOption } from "@/lib/relay/relay-types";
import { effectiveModel } from "./modelCatalog";

type EffortLabels = Dictionary["chat"]["composer"]["effortLabels"];

/** The catalog entry of the model a session is actually on (its explicit
 * pick, else the CLI's default) — `null` while the catalog or the model isn't
 * known yet. */
export function effectiveModelOption(catalog: ModelCatalog | null | undefined, model: ModelChoice | null): ModelOption | null {
  const id = effectiveModel(catalog, model);
  return (id !== null ? catalog?.options.find((option) => option.id === id) : undefined) ?? null;
}

/** The efforts the session's effective model accepts, in the CLI's order.
 * Empty means the model takes none — the dropdown stays hidden. */
export function effortsFor(catalog: ModelCatalog | null | undefined, model: ModelChoice | null): readonly EffortOption[] {
  return effectiveModelOption(catalog, model)?.efforts ?? [];
}

/** What the session is actually on: the explicit pick, else the model's own
 * default (`null` when the CLI reports none — Claude — shown as "Default"). */
export function effectiveEffort(option: ModelOption | null, choice: string | null): string | null {
  return choice ?? option?.defaultEffort ?? null;
}

/** Whether the effective model lists `effort` (a remembered pick is only
 * applied when it does). */
export function modelAcceptsEffort(catalog: ModelCatalog | null | undefined, model: ModelChoice | null, effort: string): boolean {
  return effortsFor(catalog, model).some((entry) => entry.id === effort);
}

/** The dictionary's label for a known level, the raw id otherwise — a level a
 * CLI adds tomorrow still shows up instead of disappearing. */
export function labelForEffort(labels: EffortLabels, id: string): string {
  return (labels as Record<string, string>)[id] ?? id;
}

/** What `/effort` can be given right now: the effective model's levels (in the
 * CLI's order, with its blurbs) and whether `default` is accepted — only when
 * the CLI reports no default effort of its own, same rule as the dropdown. */
export interface EffortChoices {
  levels: readonly EffortOption[];
  offersDefault: boolean;
}

/** `null` when the effective model takes no effort, so `/effort` isn't offered. */
export function effortChoicesFor(catalog: ModelCatalog | null | undefined, model: ModelChoice | null): EffortChoices | null {
  const option = effectiveModelOption(catalog, model);
  const levels = option?.efforts ?? [];
  return levels.length > 0 ? { levels, offersDefault: option?.defaultEffort === undefined } : null;
}
