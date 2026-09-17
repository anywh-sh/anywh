import { useEffect } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { inTauri } from "@/lib/platform/tauri";
import { parseImportProfileUrl } from "@/lib/profiles/profileImport";
import { enqueueProfileSetup } from "@/lib/profiles/profileSetup";

/**
 * Listens for `anywh://import-profile` deep links (see profileImport.ts
 * for the URL format, src-tauri/tauri.conf.json for the OS-registered
 * scheme) and hands each one to `profileSetup.ts`'s queue — no callback out
 * of this hook anymore (decision 1: nothing here switches profile, or does
 * anything else React-observable, on its own).
 *
 * Two delivery paths, both handled: `getCurrent()` covers a cold launch
 * (the OS started the app *because* of the link — the common case for a
 * pairing flow, since the app usually isn't running yet), `onOpenUrl` covers
 * the link arriving while the app is already open. `onOpenUrl` needs the
 * single-instance plugin to fire at all on Windows/Linux (the OS spawns a
 * second process and hands it the URL as a CLI argument instead of
 * notifying the running one) — now wired up in src-tauri/src/lib.rs with
 * the plugin's `deep-link` feature, so all three desktop platforms deliver
 * both paths.
 *
 * Neither path is the only way in: `AddRemoteMachineDialog` feeds the same
 * queue from a typed pairing code, for whoever has a code but no working
 * link (a platform where `anywh://` isn't registered, a browser that
 * swallowed it, a code read off another screen).
 */
export function useProfileImport(): void {
  useEffect(() => {
    if (!inTauri()) return;

    function handle(urls: string[]): void {
      for (const url of urls) {
        const params = parseImportProfileUrl(url);
        if (!params) {
          console.error(`useProfileImport: ignoring unrecognized deep link: ${url}`);
          continue;
        }
        enqueueProfileSetup({ source: "params", params });
      }
    }

    // Deferred by a tick, same trick as tailnetSidecar.ts's release delay
    // and useRelayClient.ts's start() — React 18 StrictMode (dev) mounts
    // this effect, cleans it up, and mounts it again, synchronously, within
    // one tick. The claim itself moved out of this hook (profileSetup.ts's
    // own dedup, keyed off `claimUrl`/`joinCode`, is what actually stops a
    // join code from ever being redeemed twice now) — but calling
    // `getCurrent()` straight from the effect would still let the doomed
    // first mount fire its own native IPC round trip and enqueue a request
    // that gets silently deduped a moment later, on every cold launch.
    // Deferring means the first mount's cleanup clears its timer before it
    // ever fires; only the surviving mount ever calls `getCurrent()` at
    // all, so the common case stays "one enqueue", not "two, one of which
    // is a no-op".
    const initialUrlTimer = setTimeout(() => {
      void getCurrent().then((urls) => {
        if (urls) handle(urls);
      });
    }, 0);

    const unlistenPromise = onOpenUrl(handle);

    return () => {
      clearTimeout(initialUrlTimer);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
