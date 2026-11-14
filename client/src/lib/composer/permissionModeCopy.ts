import type { Dictionary } from "@/i18n";
import type { KnownAgentId, KnownPermissionModeId } from "@/i18n/dictionary";
import type { PermissionMode } from "@/lib/relay/relay-types";

/** A permission mode's label and hint for this session's agent: the agent's
 * own copy when its mode behaves unlike another agent's of the same id
 * (`modeByAgent`), else the shared copy, else the raw id with no hint (a mode
 * this build doesn't know — visible, not fatal). */
export function permissionModeCopy(composer: Dictionary["chat"]["composer"], agentId: string | null | undefined, id: PermissionMode): { label: string; hint: string } {
  const own = agentId ? composer.modeByAgent[agentId as KnownAgentId]?.[id as KnownPermissionModeId] : undefined;
  return own ?? composer.mode[id as KnownPermissionModeId] ?? { label: id, hint: "" };
}
