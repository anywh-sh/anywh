import type { Dictionary } from "@/i18n";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import type { NativeTopBarMenuPayload } from "@/lib/platform/nativeShell";
import type { ModelCatalog, ModelChoice } from "@/lib/relay/relay-types";

export interface TopBarMenuModelInput {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  /** The model can't change once the conversation has had its first turn. */
  locked: boolean;
  connected: boolean;
  dict: Dictionary;
}

/** What the iOS top bar's dropdown shows. `model: null` when there is no
 * catalog, so the bar stays a plain label. */
export function buildTopBarMenuPayload({ catalog, model, locked, connected, dict }: TopBarMenuModelInput): NativeTopBarMenuPayload {
  if (!catalog || catalog.options.length === 0) return { model: null };
  const currentId = effectiveModel(catalog, model);
  return {
    model: {
      label: dict.shell.titleBar.model,
      currentId,
      currentLabel: currentId ? labelForModel(catalog, currentId) : dict.chat.composer.pending,
      options: catalog.options.map((option) => ({ id: option.id, label: option.label })),
      locked,
      lockedHint: dict.chat.composer.modelLocked,
      enabled: connected && currentId !== null && !locked,
    },
  };
}
