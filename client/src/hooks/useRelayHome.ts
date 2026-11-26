import { useEffect, useState } from "react";
import type { Profile } from "@/lib/profiles/profiles";
import { listDirectories } from "@/lib/relay/fsBrowse";

/** One request per relay, kept for the app's run: the home folder doesn't
 * move. A failed one isn't kept, so the next ask tries again. */
const homes = new Map<string, Promise<string | null>>();

function relayKey(profile: Profile): string {
  return `${profile.id}@${profile.host}:${String(profile.relayPort)}`;
}

/** The profile's home folder on the relay's machine: the folder `GET /fs/list`
 * lists without a path (the relay's `defaultCwd`). */
export function relayHome(profile: Profile): Promise<string | null> {
  const key = relayKey(profile);
  let pending = homes.get(key);
  if (!pending) {
    pending = listDirectories(profile).then(
      (result) => result.path,
      () => {
        homes.delete(key);
        return null;
      },
    );
    homes.set(key, pending);
  }
  return pending;
}

/** `relayHome` for a component: `null` until it is known, or while
 * `enabled` is off. What `~` means in a typed path, and how a path is shown
 * (`displayPath`). */
export function useRelayHome(profile: Profile, enabled: boolean): string | null {
  const [home, setHome] = useState<{ key: string; path: string | null } | null>(null);
  const key = relayKey(profile);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void relayHome(profile).then((path) => {
      if (live) setHome({ key, path });
    });
    return () => {
      live = false;
    };
    // `key` covers every field of the profile the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return enabled && home?.key === key ? home.path : null;
}
