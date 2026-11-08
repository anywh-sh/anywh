import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useForegroundSync } from "@/hooks/relay/useForegroundSync";
import { EMPTY_PROFILE_INTEGRATIONS, type ProfileIntegrations } from "@/lib/integrations/derive";
import type { IntegrationsClientMessage } from "@/lib/integrations/model";
import { IntegrationsWatch } from "@/lib/integrations/watch";
import { isBrokeredProfile, type Profile } from "@/lib/profiles/profiles";

export interface IntegrationsState {
  /** Every watched profile, keyed by id. */
  byProfile: Record<string, ProfileIntegrations>;
  /** Sends on a profile's integrations socket; false when it is not live. */
  send: (profileId: string, message: IntegrationsClientMessage) => boolean;
}

/** The fields that decide where and how a profile is dialed. */
function connectionKey(profile: Profile): string {
  return JSON.stringify([
    profile.host,
    profile.relayPort,
    profile.connectToken,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
  ]);
}

interface Entry {
  key: string;
  watch: IntegrationsWatch;
}

/**
 * The integrations of every profile that has a tab open: one
 * `/integrations/watch` socket per such profile, kept while one of its tabs
 * is, so the rail of any tab on screen has its profile's state — and the
 * last state stays shown, stale, while the machine is unreachable. Only the
 * active tab's profile may wake a sleeping machine.
 */
export function useIntegrations(profiles: readonly Profile[], activeProfileId: string | null): IntegrationsState {
  const watchesRef = useRef(new Map<string, Entry>());
  const [byProfile, setByProfile] = useState<Record<string, ProfileIntegrations>>({});
  const activeRef = useRef(activeProfileId);
  activeRef.current = activeProfileId;

  const profilesKey = JSON.stringify(profiles.map((profile) => [profile.id, connectionKey(profile)]));
  useEffect(() => {
    const watches = watchesRef.current;
    const wanted = new Set(profiles.map((profile) => profile.id));
    for (const [id, entry] of watches) {
      if (wanted.has(id)) continue;
      entry.watch.stop();
      watches.delete(id);
    }
    for (const profile of profiles) {
      const key = connectionKey(profile);
      const existing = watches.get(profile.id);
      if (existing?.key === key) continue;
      existing?.watch.stop();
      const watch = new IntegrationsWatch(profile, {
        wake: profile.id === activeRef.current,
        periodicPing: !isBrokeredProfile(profile),
        onChange: (state) => {
          if (watchesRef.current.get(profile.id)?.watch !== watch) return;
          setByProfile((prev) => ({ ...prev, [profile.id]: state }));
        },
      });
      watches.set(profile.id, { key, watch });
      watch.start();
    }
    // What a replaced or removed watch showed belongs to a connection that
    // no longer exists.
    setByProfile(() => {
      const next: Record<string, ProfileIntegrations> = {};
      for (const [id, entry] of watches) next[id] = entry.watch.current;
      return next;
    });
    // `profiles` is read through `profilesKey`, which covers every field used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesKey]);

  useEffect(() => {
    const watches = watchesRef.current;
    return () => {
      for (const entry of watches.values()) entry.watch.stop();
      watches.clear();
    };
  }, []);

  useEffect(() => {
    if (activeProfileId) watchesRef.current.get(activeProfileId)?.watch.retryNow({ wake: true });
  }, [activeProfileId]);

  const onForeground = useCallback(() => {
    for (const entry of watchesRef.current.values()) entry.watch.retryNow({ wake: false });
  }, []);
  useForegroundSync(onForeground, { poll: false });

  const send = useCallback((profileId: string, message: IntegrationsClientMessage) => watchesRef.current.get(profileId)?.watch.send(message) ?? false, []);

  return useMemo(() => ({ byProfile, send }), [byProfile, send]);
}

/** The integrations state, for what sits deep inside a tab (the rail, the
 * pane) without threading it through every memoized panel. `null` outside
 * the shell's provider. */
export const IntegrationsContext = createContext<IntegrationsState | null>(null);

/** One profile's integrations and a sender bound to it. */
export function useProfileIntegrations(profileId: string): {
  entry: ProfileIntegrations;
  send: (message: IntegrationsClientMessage) => boolean;
} | null {
  const context = useContext(IntegrationsContext);
  const send = useCallback((message: IntegrationsClientMessage) => context?.send(profileId, message) ?? false, [context, profileId]);
  if (!context) return null;
  return { entry: context.byProfile[profileId] ?? EMPTY_PROFILE_INTEGRATIONS, send };
}
