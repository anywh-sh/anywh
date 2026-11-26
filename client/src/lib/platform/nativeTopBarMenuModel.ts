import type { Dictionary } from "@/i18n";
import { agentName } from "@/lib/composer/agentName";
import { effectiveEffort, labelForEffort } from "@/lib/composer/effortCatalog";
import { effectiveModel, labelForModel } from "@/lib/composer/modelCatalog";
import { displayPath, folderName } from "@/lib/files/folderPath";
import type { NativeTopBarMenuPayload } from "@/lib/platform/nativeShell";
import { permissionModeCopy } from "@/lib/composer/permissionModeCopy";
import type { ModelCatalog, ModelChoice, ModelOption, PermissionMode, PermissionModeOption } from "@/lib/relay/relay-types";

export interface TopBarMenuModelInput {
  catalog: ModelCatalog | null | undefined;
  model: ModelChoice | null;
  /** The model can't change once the conversation has had its first turn. */
  locked: boolean;
  connected: boolean;
  permissionMode: PermissionMode | null;
  permissionModes: PermissionModeOption[];
  /** The session's agent: the agent entry's current pick, and the copy of a
   * mode whose copy is the agent's own. */
  agentId?: string | null;
  /** Ids of the agents the relay can run; fewer than two = no agent entry. */
  agents?: string[];
  /** The explicit effort pick (`null` = the model's default). */
  effort?: string | null;
  /** The effective model's catalog entry; `null`/absent = no effort menu. */
  effortCatalogOption?: ModelOption | null;
  /** The conversation's folder: shown once `locked` fixed it. */
  cwd?: string | null;
  /** The home folder on the relay's machine, to show the folder from `~`. */
  home?: string | null;
  dict: Dictionary;
}

/** Id of the "no explicit pick" row in the effort menu, offered only when the
 * CLI reports no default effort. Not a real level id, so it can't collide. */
export const EFFORT_DEFAULT_ROW_ID = "default";

/** Same copy as `PermissionModeButton` (`permissionModeCopy`). */
function modeCopy(dict: Dictionary, agentId: string | null | undefined, id: PermissionMode): { label: string; hint: string } {
  return permissionModeCopy(dict.chat.composer, agentId, id);
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
  agentId = null,
  agents = [],
  effort = null,
  effortCatalogOption = null,
  cwd = null,
  home = null,
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
            currentLabel: permissionMode !== null ? modeCopy(dict, agentId, permissionMode).label : dict.chat.composer.pending,
            options: permissionModes.map((option) => ({ id: option.id, ...modeCopy(dict, agentId, option.id) })),
            enabled: connected && permissionMode !== null,
          },
    effort: buildEffortMenu({ effort, option: effortCatalogOption, connected, dict }),
    agent: buildAgentMenu({ agents, agentId, locked, connected, dict }),
    // Fixed with the model; before that the capsule above the composer has it.
    cwd: locked && cwd !== null ? { label: dict.shell.cwdPicker.title, name: folderName(cwd), path: displayPath(cwd, home) } : null,
  };
}

/** Same rules as the desktop menu's agent row: offered only with more than
 * one agent, and fixed with the model once the conversation has had a turn. */
function buildAgentMenu({
  agents,
  agentId,
  locked,
  connected,
  dict,
}: {
  agents: string[];
  agentId: string | null;
  locked: boolean;
  connected: boolean;
  dict: Dictionary;
}): NativeTopBarMenuPayload["agent"] {
  if (agents.length < 2) return null;
  const names = dict.chat.composer.agentNames;
  return {
    label: dict.chat.composer.menu.agent,
    currentId: agentId,
    currentLabel: agentId !== null ? agentName(names, agentId) : dict.chat.composer.pending,
    options: agents.map((id) => ({ id, label: agentName(names, id) })),
    locked,
    lockedHint: dict.chat.composer.modelLocked,
    enabled: connected && agentId !== null && !locked,
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
