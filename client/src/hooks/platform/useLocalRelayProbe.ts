import { useEffect, useState } from "react";
import { localInstallPossible, probeLocalRelay, type LocalRelayProbe } from "@/lib/install/localRelay";

/** One-shot read of this machine's own relay install, if any — `null` while
 * unresolved or when the in-app installer doesn't exist on this platform at
 * all (`localInstallPossible()`). Same shape as `FirstRun.tsx`'s own probe
 * effect, without that screen's routing: callers here only ever want
 * `installedVersion` and the registered profile list. */
export function useLocalRelayProbe(): LocalRelayProbe | null {
  const [probe, setProbe] = useState<LocalRelayProbe | null>(null);

  useEffect(() => {
    if (!localInstallPossible()) return;
    let cancelled = false;
    void probeLocalRelay().then((result) => {
      if (!cancelled) setProbe(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return probe;
}
