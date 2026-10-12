import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getPushAddressProvider, isPushAddress, onPushAddressProviderChange, type PushAddress } from "@/lib/platform/pushAddress";
import { ensureRegistered, hasRegistration, unregister } from "@/lib/platform/pushRegistration";
import { onProfileRemoving, type Profile } from "@/lib/profiles/profiles";

/**
 * Keeps this device's push address registered on every relay it uses
 * (docs/push.md). Inert without an installed provider — which is every
 * build of the open client. With one: the address is read when it arrives
 * and whenever it changes, and registered on each profile's relay when it
 * arrives, when a profile is added, and on launch (once a day if nothing
 * changed — see `shouldRegister`). When the address goes away (signed out),
 * or a profile is removed, it is taken off the relay(s) concerned.
 */
export function usePushRegistration(profiles: readonly Profile[]): void {
  const provider = useSyncExternalStore(onPushAddressProviderChange, getPushAddressProvider);
  const [address, setAddress] = useState<PushAddress | null>(null);

  useEffect(() => {
    if (!provider) {
      setAddress(null);
      return;
    }
    let cancelled = false;
    const accept = (next: unknown) => {
      if (!cancelled) setAddress(isPushAddress(next) ? next : null);
    };
    void provider.getAddress().then(accept, () => accept(null));
    const unsubscribe = provider.subscribe(accept);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [provider]);

  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  // What the relays need to hear about changes only with the address or with
  // which relays there are — not with every unrelated edit of a profile.
  const relays = JSON.stringify(profiles.map((p) => [p.id, p.host, p.relayPort]));
  const hadAddress = useRef(false);

  useEffect(() => {
    if (address) {
      hadAddress.current = true;
      void Promise.allSettled(profilesRef.current.map((profile) => ensureRegistered(profile, address)));
    } else if (hadAddress.current) {
      hadAddress.current = false;
      void Promise.allSettled(profilesRef.current.map((profile) => unregister(profile)));
    }
  }, [address, relays]);

  useEffect(
    () =>
      onProfileRemoving((profile) => {
        if (hasRegistration(profile.id)) void unregister(profile);
      }),
    [],
  );
}
