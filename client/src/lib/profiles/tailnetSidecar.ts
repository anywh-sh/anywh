import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform/tauri";
import { reportTailnetKey } from "@/lib/profiles/tailnetBroker";
import type { Profile } from "@/lib/profiles/profiles";

export interface TailnetEndpoint {
  host: string;
  port: number;
}

/** What a cold `tailnet_sidecar_start` (Rust) resolves to — mirrors
 * `TailnetUpResult` on that side. `nodeKey` is only ever set on a cold
 * start; an already-running sidecar's second caller gets `undefined`
 * (see `Running`/the Rust command's own doc comment) because the report
 * below only needs to happen once per join, not once per caller. */
interface TailnetUpResult {
  addr: string;
  nodeKey?: string;
}

interface Entry {
  refCount: number;
  endpoint: Promise<TailnetEndpoint>;
  /** Set while a teardown is scheduled but hasn't run yet — see
   * `releaseTailnetSidecar`'s comment for why this exists. */
  pendingStop?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

function parseAddr(addr: string): TailnetEndpoint {
  const separator = addr.lastIndexOf(":");
  return { host: addr.slice(0, separator), port: Number(addr.slice(separator + 1)) };
}

/** Starts (or joins an already-starting/started) tailnet-sidecar for
 * `profile.id`, ref-counted so every tab open on the same tailnet profile
 * shares one tsnet join and one local port — mirrors the
 * dedup `tailnet_sidecar_start` (Rust) already does on its own side.
 * Callers await the same promise, so a tab that mounts while the first is
 * still joining gets the same eventual endpoint (or the same rejection)
 * instead of racing a second join. Must be paired with exactly one
 * `releaseTailnetSidecar(profile.id)` call, even if this promise rejects —
 * that's what lets a failed join be retried by the next caller instead of
 * being stuck forever on a cached rejection.
 *
 * `target` (`host:port` inside the tailnet to dial) only matters for
 * whichever call actually starts the join — a tab that finds one already
 * running (e.g. a second tab on a brokered profile, which
 * resolves its own target fresh from the broker every time) just gets that
 * one's address regardless of what it passed. The sidecar only re-resolves
 * a new target on the next *cold* start, once every tab has released it. */
export function acquireTailnetSidecar(profile: Profile, target: string): Promise<TailnetEndpoint> {
  const existing = entries.get(profile.id);
  if (existing) {
    existing.refCount += 1;
    if (existing.pendingStop !== undefined) {
      // Reclaimed within the StrictMode window described in
      // `releaseTailnetSidecar` — the join in progress (or already up) is
      // still good, cancel the teardown instead of restarting cold.
      clearTimeout(existing.pendingStop);
      existing.pendingStop = undefined;
    }
    return existing.endpoint;
  }
  const endpoint = inTauri()
    ? invoke<TailnetUpResult>("tailnet_sidecar_start", {
        profileId: profile.id,
        authKey: profile.tailnetAuthKey,
        controlUrl: profile.tailnetControlUrl,
        target,
        brokerNodeId: profile.brokerNodeId,
      }).then((result) => {
        // Fire-and-forget, deliberately not awaited: nothing here needs the
        // report to land before the sidecar is usable for its actual job.
        if (result.nodeKey) void reportTailnetKey(profile, result.nodeKey);
        return parseAddr(result.addr);
      })
    : Promise.reject(new Error("tailnet mode needs the Tauri sidecar, not available in a plain browser"));
  entries.set(profile.id, { refCount: 1, endpoint });
  return endpoint;
}

/** Reads the endpoint of a sidecar some owner already has running for
 * `profileId`, without acquiring a reference of its own — for a consumer
 * that just needs to dial the tunnel for one HTTP/WS call (any traffic
 * that isn't the chat's own WebSocket) and relies on a longer-lived
 * owner (`useTailnetSidecarOwner` at the App level, or a chat tab's
 * `useRelayClient`) to already be holding the join open. Acquiring here
 * too would double-count correctly (the ref-count already supports several
 * owners), but releasing right after — the only sane thing a one-off caller
 * could do — would tear the sidecar down the instant the real owner's own
 * reference briefly bounced to zero between renders, refiring the whole
 * `tsnet` join. `undefined` when nobody owns this profile's sidecar yet
 * (e.g. a background tailnet profile queried without ever being opened) —
 * the caller decides whether to fall back to its own acquire/release. */
export function peekTailnetSidecar(profileId: string): Promise<TailnetEndpoint> | undefined {
  return entries.get(profileId)?.endpoint;
}

/** Releases one reference acquired via `acquireTailnetSidecar` — once the
 * last tab on a profile releases it, the sidecar is actually stopped. Safe
 * to call for a profile that was never acquired (a no-op) — e.g. cleanup
 * running for a tab that switched profile before its first render.
 *
 * The actual teardown is deferred, not immediate, by `graceMs`. The default
 * (`0`) exists for React 18 StrictMode (dev only), which double-invokes the
 * effect that owns this profile's sidecar — mount, cleanup, mount again —
 * all synchronously, before the first `tsnet` join has had any chance to
 * finish. Tearing down on that first cleanup killed the join mid-flight
 * every time, so the second mount always started cold, and any caller ahead
 * of the second `acquireTailnetSidecar` (the chat `RelayClient`,
 * `useSessionNames`, ...) was left racing a WebSocket against a sidecar with
 * no port yet — this is the concrete bug behind the client connecting to
 * `127.0.0.1:0` and looping on "reconnecting" forever. `0` is enough for
 * that case: StrictMode's mount/cleanup/mount replay happens inside the same
 * tick, well before any timer fires, so a genuine same-profile reacquire
 * always lands before this runs and cancels it (see `acquireTailnetSidecar`).
 *
 * A non-zero `graceMs` covers a slower handover: `profileSetup.ts`'s
 * `ProfileSetupDialog` holds a reference across "Continuar para novo
 * perfil", and the real new owner (`useTailnetSidecarOwner`) only reclaims
 * it after a passive-effect flush plus its own internal deferral plus a
 * round-trip to the broker — far more than one tick. Either way, only a
 * real "nobody wants this anymore" reaches the timeout body. */
export function releaseTailnetSidecar(profileId: string, graceMs = 0): void {
  const entry = entries.get(profileId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  entry.pendingStop = setTimeout(() => {
    entries.delete(profileId);
    // Fire-and-forget: nothing downstream needs to await the child actually
    // dying, and outside Tauri there's nothing to stop in the first place.
    if (inTauri()) void invoke("tailnet_sidecar_stop", { profileId });
  }, graceMs);
}
