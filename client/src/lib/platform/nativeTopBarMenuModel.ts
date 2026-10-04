import type { Dictionary } from "@/i18n";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import type { NativeTopBarMenuPayload } from "@/lib/platform/nativeShell";
import type { KnownPermissionModeId } from "@/i18n/dictionary";
import type { ModelCatalog, ModelChoice, PermissionMode, PermissionModeOption } from "@/lib/relay/relay-types";

export interface TopBarMenuModelInput {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  /** The model can't change once the conversation has had its first turn. */
  locked: boolean;
  connected: boolean;
  permissionMode: PermissionMode | null;
  permissionModes: PermissionModeOption[];
  dict: Dictionary;
}

/** Same id-to-copy fallback as `PermissionModeButton`: an id this build
 * doesn't know renders raw, with no hint. */
function modeCopy(dict: Dictionary, id: PermissionMode): { label: string; hint: string } {
  return dict.chat.composer.mode[id as KnownPermissionModeId] ?? { label: id, hint: "" };
}

/** What the iOS top bar's dropdown shows. Each entry is `null` when there is
 * nothing to offer for it; with both `null` the bar stays a plain label. */
export function buildTopBarMenuPayload({
  catalog,
  model,
  locked,
  connected,
  permissionMode,
  permissionModes,
  dict,
}: TopBarMenuModelInput): NativeTopBarMenuPayload {
  return {
    model: buildModelMenu({ catalog, model, locked, connected, dict }),
    mode:
      permissionModes.length === 0
        ? null
        : {
            label: dict.shell.titleBar.mode,
            currentId: permissionMode,
            currentLabel: permissionMode !== null ? modeCopy(dict, permissionMode).label : dict.chat.composer.pending,
            options: permissionModes.map((option) => ({ id: option.id, ...modeCopy(dict, option.id) })),
            enabled: connected && permissionMode !== null,
          },
  };
}

function buildModelMenu({ catalog, model, locked, connected, dict }: Pick<TopBarMenuModelInput, "catalog" | "model" | "locked" | "connected" | "dict">): NativeTopBarMenuPayload["model"] {
  if (!catalog || catalog.options.length === 0) return null;
  const currentId = effectiveModel(catalog, model);
  return {
    label: dict.shell.titleBar.model,
    currentId,
    currentLabel: currentId ? labelForModel(catalog, currentId) : dict.chat.composer.pending,
    options: catalog.options.map((option) => ({ id: option.id, label: option.label })),
    locked,
    lockedHint: dict.chat.composer.modelLocked,
    enabled: connected && currentId !== null && !locked,
  };
}
