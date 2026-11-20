import type { KnownAgentId } from "@/i18n/dictionary";

/** Same id-switch-with-literal-fallback shape as `PermissionModeButton`'s
 * `modeCopy` — an agent id this build has no name for (a def added after
 * this build shipped) renders as the raw id rather than crashing. */
export function agentName(agentNames: Record<KnownAgentId, string>, id: string): string {
  return agentNames[id as KnownAgentId] ?? id;
}
