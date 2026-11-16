import { useSyncExternalStore } from "react";
import { agentSignedOutNow, subscribePlanUsage } from "@/lib/planUsage/signedOutAgents";

/** Whether `agentId` has no login on `profileId` right now (`null` agent:
 * not known yet, so no). */
export function useAgentSignedOut(profileId: string, agentId: string | null): boolean {
  return useSyncExternalStore(subscribePlanUsage, () => (agentId === null ? false : agentSignedOutNow(profileId, agentId)));
}
