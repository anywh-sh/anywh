import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ConnectCard } from "@/components/integrations/ConnectCard";
import type { Profile } from "@/lib/profiles/profiles";

/** Opens the connect card of one profile's integration. */
export type OpenConnectCard = (profileId: string, integrationId: string) => void;

const ConnectCardContext = createContext<OpenConnectCard | null>(null);

/**
 * Holds the one connect card of the window, so every way into it — the
 * integration's pane, the "+" after adding, a failed call in the chat, the
 * chip above the composer — opens the same card, from wherever it sits.
 * Lives inside the integrations provider: the card reads and sends through it.
 */
export function ConnectCardProvider({ profiles, children }: { profiles: readonly Profile[]; children: ReactNode }) {
  const [target, setTarget] = useState<{ profileId: string; integrationId: string } | null>(null);
  const open = useCallback<OpenConnectCard>((profileId, integrationId) => setTarget({ profileId, integrationId }), []);
  const profile = target ? profiles.find((entry) => entry.id === target.profileId) : undefined;
  return (
    <ConnectCardContext.Provider value={open}>
      {children}
      {profile && <ConnectCard profile={profile} integrationId={target?.integrationId ?? null} onOpenChange={(next) => !next && setTarget(null)} />}
    </ConnectCardContext.Provider>
  );
}

/** The card opener; `null` outside the shell (a panel rendered on its own). */
export function useConnectCard(): OpenConnectCard | null {
  return useContext(ConnectCardContext);
}
