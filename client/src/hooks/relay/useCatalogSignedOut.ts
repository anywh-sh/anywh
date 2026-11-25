import { useCallback, useEffect, useState } from "react";
import { fetchAgentsCatalog, type AgentsCatalog } from "@/lib/install/agentsCatalog";
import type { Profile } from "@/lib/profiles/profiles";

/** Pure: whether the relay's agent list says `agentId` has no login. An
 * agent it doesn't list, or whose login it couldn't read (`null`, an older
 * relay), says nothing: no banner for a login that may well be there. */
export function catalogSaysSignedOut(catalog: AgentsCatalog, agentId: string): boolean {
  return catalog.agents.some((agent) => agent.id === agentId && agent.loggedIn === false);
}

/**
 * Whether `agentId` has no login on `profile`, read from the relay's own
 * agent list (`GET /control/agents`) — for a client that reads no plan
 * usage (iOS), which is what tells the desktop. Read while `enabled` (the
 * chat is connected), again whenever the profile or agent changes, and on
 * each `recheck()`: a send blocked on it, a turn that failed for a lost
 * login, a sign-in that just finished. A failed read keeps what was known.
 */
export function useCatalogSignedOut(profile: Profile, agentId: string | null, enabled: boolean): { signedOut: boolean; recheck: () => void } {
  const [reading, setReading] = useState<{ key: string; signedOut: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = `${profile.id}:${agentId ?? ""}`;

  useEffect(() => {
    if (!enabled || agentId === null) return;
    let cancelled = false;
    fetchAgentsCatalog(profile).then(
      (catalog) => {
        if (!cancelled) setReading({ key, signedOut: catalogSaysSignedOut(catalog, agentId) });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // `profile` is read through `key`: a new object for the same profile
    // must not read the list again on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, nonce]);

  const recheck = useCallback(() => setNonce((current) => current + 1), []);
  return { signedOut: reading?.key === key && reading.signedOut, recheck };
}
