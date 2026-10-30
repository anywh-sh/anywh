import type { AgentPreference } from "@/lib/relay/relay-types";

/** Relay's own fallback when nothing else decides (`DEFAULT_AGENT_ID` in
 * relay/src/session/sessionStore.ts). */
export const FALLBACK_AGENT_ID = "claude";

/**
 * Agent a new conversation of a profile should start on, from the profile's
 * preference (mirrored from the host) and the agents this host can run:
 * a "fixed" pick that is still selectable wins; else the last used agent if
 * selectable; else the first selectable one; else the relay's own default.
 */
export function resolveDefaultAgent(
  preference: AgentPreference | undefined,
  lastUsedAgentId: string | undefined,
  selectable: readonly string[],
): string {
  if (preference?.mode === "fixed" && preference.fixedAgentId && selectable.includes(preference.fixedAgentId)) {
    return preference.fixedAgentId;
  }
  if (lastUsedAgentId && selectable.includes(lastUsedAgentId)) return lastUsedAgentId;
  return selectable[0] ?? FALLBACK_AGENT_ID;
}
