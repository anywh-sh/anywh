import { useEffect } from "react";
import { isTailnetProfile, type Profile } from "@/lib/profiles/profiles";
import { acquireTailnetSidecar, releaseTailnetSidecar } from "@/lib/profiles/tailnetSidecar";
import { resolveTailnetTarget } from "@/lib/profiles/tailnetBroker";

/**
 * Holds one sidecar reference for as long as `profile` is in play at the
 * App level — sidebar, profile sync, and theme sync (any traffic that isn't
 * the chat's own WebSocket) all run against `activeProfile`
 * before any chat tab for it ever mounts, and until now only a chat tab's
 * `useRelayClient` ever acquired a reference. Mount this once, high in the
 * tree, for whichever profile(s) those App-level hooks are reading — it
 * shares the same ref-counted map as `useRelayClient` (`tailnetSidecar.ts`),
 * so a chat tab open on the same profile just adds a second reference, and
 * tearing one down never affects the other's join.
 *
 * Doesn't expose the endpoint itself — consumers go through
 * `resolveConnection` (`connectionResolver.ts`), which peeks whatever this
 * hook (or a chat tab) already has running.
 */
export function useTailnetSidecarOwner(profile: Profile): void {
  useEffect(() => {
    if (!isTailnetProfile(profile)) return;

    let cancelled = false;
    let acquired = false;

    async function start(): Promise<void> {
      let plan;
      try {
        plan = await resolveTailnetTarget(profile);
      } catch (err) {
        console.error("tailnet-sidecar owner failed to resolve a target:", err);
        return;
      }
      if (cancelled) return;
      const acquisition = acquireTailnetSidecar(profile, plan.target);
      acquired = true;
      await acquisition.catch((err: unknown) => {
        console.error("tailnet-sidecar owner failed to join the tailnet:", err);
      });
    }

    // Same StrictMode dance as `useRelayClient.ts`'s `start()` — see its
    // comment for why a tick's deferral (not just tolerating the
    // double-invoke) is what keeps a broker grant from being spent twice by
    // the mount/cleanup/mount replay React 18 dev does synchronously.
    const startTimer = setTimeout(() => void start(), 0);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      if (acquired) releaseTailnetSidecar(profile.id);
    };
  }, [
    profile.id,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
  ]);
}
