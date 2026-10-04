import type { Dictionary } from "@/i18n";
import { effectiveEffort, labelForEffort } from "@/lib/composer/effortCatalog";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import type { NativeTopBarMenuPayload } from "@/lib/platform/nativeShell";
import type { KnownPermissionModeId } from "@/i18n/dictionary";
import type { ModelCatalog, ModelChoice, ModelOption, PermissionMode, PermissionModeOption } from "@/lib/relay/relay-types";

export interface TopBarMenuModelInput {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  /** The model can't change once the conversation has had its first turn. */
  locked: boolean;
  connected: boolean;
  permissionMode: PermissionMode | null;
  permissionModes: PermissionModeOption[];
  /** The explicit effort pick (`null` = the model's default). */
  effort?: string | null;
  /** The effective model's catalog entry; `null`/absent = no effort menu. */
  effortCatalogOption?: ModelOption | null;
  dict: Dictionary;
}

/** Id of the "no explicit pick" row in the effort menu, offered only when the
 * CLI reports no default effort. Not a real level id, so it can't collide. */
export const EFFORT_DEFAULT_ROW_ID = "default";

/** Same id-to-copy fallback as `PermissionModeButton`: an id this build
 * doesn't know renders raw, with no hint. */
function modeCopy(dict: Dictionary, id: PermissionMode): { label: string; hint: string } {
  return dict.chat.composer.mode[id as KnownPermissionModeId] ?? { label: id, hint: "" };
}

/** What the iOS top bar's dropdown shows. Each entry is `null` when there is
 * nothing to offer for it; with all `null` the bar stays a plain label. */
export function buildTopBarMenuPayload({
  catalog,
  model,
  locked,
  connected,
  permissionMode,
  permissionModes,
  effort = null,
  effortCatalogOption = null,
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
    effort: buildEffortMenu({ effort, option: effortCatalogOption, connected, dict }),
  };
}

/** Never locked, unlike the model: the CLI takes effort per turn. */
function buildEffortMenu({
  effort,
  option,
  connected,
  dict,
}: {
  effort: string | null;
  option: ModelOption | null;
  connected: boolean;
  dict: Dictionary;
}): NativeTopBarMenuPayload["effort"] {
  const levels = option?.efforts ?? [];
  if (levels.length === 0) return null;
  const labels = dict.chat.composer.effortLabels;
  const offersDefault = option?.defaultEffort === undefined;
  const current = effectiveEffort(option, effort);
  return {
    label: dict.shell.titleBar.effort,
    currentId: current ?? (offersDefault ? EFFORT_DEFAULT_ROW_ID : null),
    currentLabel: current !== null ? labelForEffort(labels, current) : dict.chat.composer.effortDefault,
    options: [
      ...(offersDefault ? [{ id: EFFORT_DEFAULT_ROW_ID, label: dict.chat.composer.effortDefault }] : []),
      ...levels.map((level) => ({ id: level.id, label: labelForEffort(labels, level.id) })),
    ],
    enabled: connected,
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
