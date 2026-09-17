import { useCallback, useEffect, useState } from "react";
import { fetchSessions } from "@/lib/relay/relayClient";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import { BrokerAsleepError, BrokerRevokedError, BrokerThrottledError } from "@/lib/profiles/tailnetBroker";
import { markProfileRevoked } from "@/lib/profiles/profileRevocation";
import { removeCachedSession, setCachedSessions, upsertCachedSession } from "@/lib/format/sessionListCache";
import { markProfileVerified } from "@/lib/profiles/profiles";
import type { Profile } from "@/lib/profiles/profiles";

// A broker that answered 429 is telling this account to stop asking — the
// watch loop's usual 2s retry is the one thing that makes that worse, and
// an account out of compute quota won't recover from anything this hook can
// do anyway. The same slow pace serves a machine that is simply asleep:
// cheap enough to keep asking (a `wake: false` call never resumes anything)
// so the sidebar reattaches on its own the moment something else brings the
// machine up, and slow enough not to be a loop anyone would notice.
const WATCH_SLOW_RETRY_MS = 60_000;

interface SyncState {
  /** Which profile `loading`/`error` actually describe — read against
   * `profile.id` on every render (see below) so a profile switch resets the
   * visible state in the SAME render, not on the next one. */
  profileId: string;
  loading: boolean;
  error: boolean;
}

function initialState(profileId: string): SyncState {
  return { profileId, loading: true, error: false };
}

/**
 * Keeps one profile — the active one — freshly synced: a full fetch when it
 * becomes active, then a live socket for as long as it stays that way.
 *
 * The rows themselves live in `sessionListCache.ts`, not here. The sidebar
 * lists every profile at once, so a hook scoped to one of them can't be the
 * source of truth for it; what this hook still owns is the part that IS
 * scoped to one profile, namely whether that profile's own sync is in
 * flight or has failed. Everything it learns it writes to the shared cache,
 * which is also why a profile switch no longer blanks the list: the
 * previous profile's rows are still cached, and still on screen.
 *
 * The relay already lists sessions ordered by last interaction (most recent
 * first — `SessionStore.listTitled`), so there's no need to reorder here.
 */
export function useSessionNames(profile: Profile): {
  /** A sync is in flight for this profile. The sidebar only turns it into a
   * skeleton when it has nothing cached for that profile yet — otherwise a
   * refresh would replace a perfectly good list with pulsing bars. */
  loading: boolean;
  error: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<SyncState>(() => initialState(profile.id));
  const [reloadTick, setReloadTick] = useState(0);

  // Adjusts state during render (React's own sanctioned pattern for "reset
  // when a prop changes") rather than in an effect, so a switch reports the
  // new profile's state in this exact render instead of a frame claiming the
  // previous profile's sync result. Stamped by `profile.id` alone, not the
  // effect's full deps list below (which also includes `host`/`brokerUrl`) —
  // a benign resync from `useProfileSync` changing one of those must refetch
  // without flipping a list the user is currently looking at back to
  // loading.
  if (state.profileId !== profile.id) setState(initialState(profile.id));

  useEffect(() => {
    let cancelled = false;
    const profileId = profile.id;
    resolveConnection(profile)
      .then(({ host, port, token }) => fetchSessions(host, port, token))
      .then((list) => {
        // Written to the cache even if this effect was cancelled meanwhile
        // (profile switched away mid-flight): the response is a real, fresh
        // list for `profileId`, and throwing it away would leave that
        // profile's rows staler than they need to be for no reason. Only
        // the loading/error flags are guarded, since those describe the
        // profile currently being shown.
        setCachedSessions(profileId, list);
        // A whole list came back: the profile is reachable, whatever an
        // interrupted setup left it marked as.
        markProfileVerified(profileId);
        if (cancelled) return;
        setState((prev) => (prev.profileId === profileId ? { ...prev, loading: false, error: false } : prev));
      })
      .catch((error: unknown) => {
        console.error("[anywh] failed to list sessions", error);
        if (error instanceof BrokerRevokedError) markProfileRevoked(profile.id);
        if (cancelled) return;
        setState((prev) => (prev.profileId === profileId ? { ...prev, loading: false, error: true } : prev));
      });
    return () => {
      cancelled = true;
    };
  }, [
    profile.id,
    profile.host,
    profile.relayPort,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
    reloadTick,
  ]);

  /** Manual retry (the sidebar's "try again") — flips back to loading right
   * away (unlike the effect above, which never touches `loading` on its own
   * for a same-profile refetch) and bumps `reloadTick` to make the effect
   * run again with the exact same profile fields. */
  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: false }));
    setReloadTick((tick) => tick + 1);
  }, []);

  // Keeps the list live across devices: a session created (and titled) or
  // renamed/deleted on ANOTHER client connected to the same relay/profile
  // (e.g. a conversation started on mobile) only reaches this device through
  // this socket — the cache writes elsewhere in the app are wired to a
  // specific open tab's `RelayClient`, which this device may not have for a
  // session it never opened. Without this, the sidebar only picked up other
  // devices' changes on the next profile switch or reload.
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    const profileId = profile.id;

    // A tailnet connection needs its own fresh, unspent connect token on
    // every new TCP connection — a reconnect
    // after `close` is a brand-new one, so this resolves again on every
    // call instead of reusing whatever `connect()` used the first time.
    // `wake` is the difference between the first connection and every
    // reconnection after it: mounting this hook is something the user did
    // (they opened the app, or picked this profile), so it is allowed to
    // bring a sleeping machine up. A socket that dropped on its own is not
    // — and the most common reason it dropped is the machine going to sleep
    // precisely because nobody was using it. Waking it there is a loop that
    // outlives the reason for it.
    function connect(options: { wake: boolean }): void {
      if (cancelled) return;
      resolveConnection(profile, { wake: options.wake })
        .then(({ host, port, token }) => {
          if (cancelled) return;
          const query = token ? `?token=${encodeURIComponent(token)}` : "";
          const ws = new WebSocket(`ws://${host}:${String(port)}/sessions/watch${query}`);
          socket = ws;
          ws.addEventListener("message", (event) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data as string);
            } catch {
              return;
            }
            if (typeof parsed !== "object" || parsed === null) return;
            const { type, id, title, lastActiveAt } = parsed as {
              type?: unknown;
              id?: unknown;
              title?: unknown;
              lastActiveAt?: unknown;
            };
            if (typeof id !== "string") return;
            if (type === "session_list_upsert" && typeof title === "string")
              upsertCachedSession(profileId, id, title, typeof lastActiveAt === "number" ? lastActiveAt : undefined);
            else if (type === "session_list_removed") removeCachedSession(profileId, id);
          });
          ws.addEventListener("close", () => {
            if (socket !== ws || cancelled) return;
            reconnectTimer = window.setTimeout(() => connect({ wake: false }), 2000);
          });
        })
        .catch((error: unknown) => {
          console.error("[anywh] failed to resolve a connection for sessions/watch", error);
          if (cancelled) return;
          // Terminal — this device's connection was deliberately revoked and
          // will never succeed again, unlike every other reason this could
          // fail (network blip, relay down), which are worth retrying.
          if (error instanceof BrokerRevokedError) {
            markProfileRevoked(profile.id);
            return;
          }
          // Two refusals that the 2s loop makes worse rather than better:
          // being throttled (it is the asking itself the broker objects to)
          // and the machine being asleep (nothing changes until the user
          // comes back, which is its own trigger).
          const slowDown = error instanceof BrokerThrottledError || error instanceof BrokerAsleepError;
          // Retrying a *failed* attempt keeps that attempt's own intent: a
          // first connection that lost a network race is still the user
          // having opened the app, and demoting its retry to `wake: false`
          // would leave them looking at a stale sidebar until they thought
          // to click away and back.
          reconnectTimer = window.setTimeout(() => connect({ wake: options.wake }), slowDown ? WATCH_SLOW_RETRY_MS : 2000);
        });
    }
    connect({ wake: true });

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [
    profile.id,
    profile.host,
    profile.relayPort,
    profile.tailnetAuthKey,
    profile.tailnetControlUrl,
    profile.tailnetTarget,
    profile.brokerUrl,
    profile.brokerNodeId,
  ]);

  return { loading: state.loading, error: state.error, reload };
}
