import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform/tauri";
import { isBrokeredProfile, type Profile } from "@/lib/profiles/profiles";

export interface ConnectGrant {
  endpoint: { host: string; port: number };
  token: string;
}

export interface GrantOptions {
  /**
   * Whether this call is allowed to bring a sleeping machine up. Defaults to
   * true — every call a person's action produced (opening the app, focusing
   * the window, opening a session) should wake it, because that is what they
   * asked for by acting.
   *
   * `false` is for the calls nobody asked for: a socket that dropped and
   * reconnects on a timer. Without it, a machine that went to sleep *because*
   * nobody was using it gets woken by the very disconnect its sleep caused,
   * in a loop that lasts as long as the window stays open.
   */
  wake?: boolean;
}

/**
 * A 410 from the broker means this device's own identity was deliberately
 * revoked (the account owner disconnected it) and will never work again —
 * distinct from every other broker failure (network unreachable, 401/403/
 * 5xx), which are transient and worth retrying at the usual pace, and from
 * a 429 (`BrokerThrottledError` below), which is transient but specifically
 * made worse by retrying at that pace.
 * Still fully generic: any self-hosted broker implementing the same "410
 * means gone for good" HTTP semantic gets the same treatment, no anywh-
 * specific string ever crosses this boundary.
 */
export class BrokerRevokedError extends Error {
  constructor() {
    super("the broker rejected this device's connection permanently (revoked)");
    this.name = "BrokerRevokedError";
  }
}

/**
 * A 429 means the broker is refusing *this account's* new connections right
 * now — it is throttling the caller, or the account has no compute quota
 * left. Unlike a network blip or a relay that's down, the one thing that
 * cannot help is asking again immediately: the caller is the problem, and
 * the outer reconnect loops treat "the broker threw" as transient and retry
 * within seconds. Generic on purpose, like `BrokerRevokedError` above: any
 * broker answering the standard HTTP semantic for "too many requests" gets
 * the same treatment, with no anywh-specific string crossing this boundary.
 */
export class BrokerThrottledError extends Error {
  /** From the body's `retry_after_ms`, when the broker offers one. */
  readonly retryAfterMs?: number;
  /** When the refusal clears: the body's `retry_at`, or now plus
   * `retry_after_ms` when only that came. Absent with no hint at all. */
  readonly retryAt?: Date;
  /** The body's `error` code, verbatim — opaque here; the UI decides which
   * ones it has words for (`resume_budget_exhausted` today). */
  readonly reason?: string;

  constructor(retryAfterMs?: number, retryAt?: Date, reason?: string) {
    super("the broker is refusing new connections for this account right now (throttled or out of quota)");
    this.name = "BrokerThrottledError";
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
    this.reason = reason;
  }
}

/** A 429 that said when it clears holds every later grant request for the
 * same profile until then — a window focus, a sidebar retry and a chat tab's
 * backoff all go through `fetchConnectGrant`, and none of them should spend
 * a request (or, for a resume-budget refusal, push the wake further out)
 * that the broker already said it would refuse. Per profile, in memory: an
 * app restart asks once and learns the same answer again. */
export interface ThrottleHold {
  /** Local clock. From `retry_after_ms` when given (relative, so a skewed
   * device clock can't cut it short), else from `retry_at`. */
  until: number;
  retryAt?: Date;
  reason?: string;
}
const throttleHolds = new Map<string, ThrottleHold>();
const throttleHoldListeners = new Set<() => void>();

/** The hold on `profileId`'s grant requests, if one was ever set — the same
 * object until it's replaced, so it works as a `useSyncExternalStore`
 * snapshot. It may already have expired: compare `until` with the clock. */
export function throttleHoldFor(profileId: string): ThrottleHold | undefined {
  return throttleHolds.get(profileId);
}

export function subscribeThrottleHolds(listener: () => void): () => void {
  throttleHoldListeners.add(listener);
  return () => throttleHoldListeners.delete(listener);
}

function heldError(profileId: string): BrokerThrottledError | undefined {
  const hold = throttleHolds.get(profileId);
  if (!hold) return undefined;
  const remaining = hold.until - Date.now();
  if (remaining <= 0) {
    throttleHolds.delete(profileId);
    return undefined;
  }
  return new BrokerThrottledError(remaining, hold.retryAt ?? new Date(hold.until), hold.reason);
}

/** Turns a 429's body into the error `fetchConnectGrant` throws, and holds
 * the profile's later grant requests until the refusal clears. Only a hint
 * that came with the refusal holds anything; a bare 429 leaves the pacing to
 * each caller's own backoff, as before. Exported for the UI tier, whose
 * broker double answers with a body instead of a signed HTTP call. */
export function refusedWith429(profileId: string, body: Record<string, unknown>): BrokerThrottledError {
  const error = throttledFrom(body);
  const until = error.retryAfterMs !== undefined ? Date.now() + error.retryAfterMs : error.retryAt?.getTime();
  if (until !== undefined && until > Date.now()) {
    throttleHolds.set(profileId, { until, retryAt: error.retryAt, reason: error.reason });
    for (const listener of throttleHoldListeners) listener();
  }
  return error;
}

function throttledFrom(hint: { error?: unknown; retry_after_ms?: unknown; retry_at?: unknown }): BrokerThrottledError {
  const retryAfterMs = typeof hint.retry_after_ms === "number" && hint.retry_after_ms >= 0 ? hint.retry_after_ms : undefined;
  const parsedAt = typeof hint.retry_at === "string" ? Date.parse(hint.retry_at) : NaN;
  const retryAt = Number.isFinite(parsedAt)
    ? new Date(parsedAt)
    : retryAfterMs !== undefined
      ? new Date(Date.now() + retryAfterMs)
      : undefined;
  const reason = typeof hint.error === "string" ? hint.error : undefined;
  return new BrokerThrottledError(retryAfterMs, retryAt, reason);
}

/**
 * The broker answered "that target is asleep, and you asked me not to wake
 * it" — the 409 sibling of the resuming one, distinguished by carrying no
 * retry hint, because nothing is in flight to wait for. Only ever reachable
 * for a caller that passed `{ wake: false }`, i.e. a background reconnect.
 * Transient like a 429, terminal like nothing: what changes it is the user
 * coming back to the app, not time passing.
 */
export class BrokerAsleepError extends Error {
  constructor() {
    super("the broker says this profile's compute is asleep, and this call asked not to wake it");
    this.name = "BrokerAsleepError";
  }
}

interface SignResult {
  ts: number;
  sig: string;
}

// How long to keep asking a broker that answers "not ready yet". The
// control plane's own hint is optimistic (`eta_ms: 5000`) — what's actually
// being waited on is a Vercel Sandbox resuming from a snapshot and its
// supervisor rejoining the tailnet, which is tens of seconds from cold.
// Waiting a while beats failing on something that was always going to work.
const RESUME_DEADLINE_MS = 120_000;
// Used when a broker answers 409 without saying how long to wait.
const DEFAULT_RETRY_AFTER_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls a brokered profile's `brokerUrl` for a fresh
 * connection grant. Generic on purpose — this code has no idea what API it's
 * actually talking to: it signs an empty POST body against `brokerUrl`'s
 * path with the device identity (`tailnet_sidecar_sign`) and sends it
 * with a small fixed set of headers (`X-Node-Id`/`Ts`/`Sig`), deliberately
 * not the `X-Anywh-*` convention the hosted control plane uses among its own
 * internal services — a self-hoster's own broker could register these same
 * three names without ever learning that convention exists. Only
 * `{endpoint, token}` from the response is read; anything else
 * (`expiresInSeconds`, or any anywh-specific field) is ignored.
 *
 * Must be called fresh before every new connection, never cached —
 * the token authorizes exactly one handshake.
 *
 * A 409 is not a failure but a state: the broker is saying the compute
 * isn't reachable *yet* and to ask again (the control plane answers this
 * while a suspended sandbox resumes). Still generic — "409 plus an optional
 * `retry_after_ms`" is a contract a self-hoster's own broker can implement
 * without knowing anything about anywh.
 */
export async function fetchConnectGrant(profile: Profile, options?: GrantOptions): Promise<ConnectGrant> {
  if (!isBrokeredProfile(profile)) throw new Error("profile has no broker configured");
  if (!inTauri()) throw new Error("the broker call needs the Tauri sidecar to sign it, not available in a plain browser");

  const url = new URL(profile.brokerUrl!);
  // Only ever sent to say "no": a broker that doesn't know the parameter
  // ignores an unknown query param and behaves exactly as before, which is
  // what keeps this safe to send at a self-hosted broker too.
  if (options?.wake === false) url.searchParams.set("wake", "false");
  const held = heldError(profile.id);
  if (held) throw held;
  const deadline = Date.now() + RESUME_DEADLINE_MS;
  for (;;) {
    // Signed inside the loop, once per attempt: the signature carries its
    // own timestamp and the control plane rejects a repeat as a replay,
    // so a retry reusing the first attempt's signature
    // would fail for a reason that has nothing to do with what it's
    // waiting for.
    const { ts, sig } = await invoke<SignResult>("tailnet_sidecar_sign", {
      method: "POST",
      path: url.pathname,
      body: "",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Node-Id": profile.brokerNodeId!,
        "X-Node-Ts": String(ts),
        "X-Node-Sig": sig,
      },
    });

    if (response.status === 409) {
      const hint = (await response.json().catch(() => ({}))) as { state?: string; retry_after_ms?: number };
      // "Asleep" is not "coming up": waiting the resume out would burn the
      // whole deadline on something that was never scheduled to happen.
      if (hint.state === "suspended") throw new BrokerAsleepError();
      if (Date.now() >= deadline) {
        throw new Error("broker is still resuming the compute after waiting for it");
      }
      await delay(hint.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS);
      continue;
    }
    if (!response.ok) {
      if (response.status === 410) throw new BrokerRevokedError();
      if (response.status === 429) {
        throw refusedWith429(profile.id, (await response.json().catch(() => ({}))) as Record<string, unknown>);
      }
      throw new Error(`broker refused the connection request (${String(response.status)})`);
    }
    const body = (await response.json()) as Partial<ConnectGrant>;
    if (!body.endpoint || typeof body.token !== "string") throw new Error("broker response missing endpoint/token");
    return { endpoint: body.endpoint, token: body.token };
  }
}

/**
 * Reports this device's freshly earned tsnet node key to the control plane
 * (called by `tailnetSidecar.ts` right after a
 * cold `tailnet_sidecar_start`). The deep-link pairing flow's own
 * hostname/nodeId cross-check on the control-plane side
 * needs this to mark the device paired right away — without it, pairing
 * still eventually resolves through that control plane's own hourly
 * reconciliation sweep (it matches unbound devices by hostname, which is
 * now this profile's own node id), just up to an hour late. A no-op for a
 * profile with no `tailnetReportUrl` (manually configured, nothing to
 * report to) — same generic-POST shape as `fetchConnectGrant`, signed with
 * `tailnet_sidecar_sign` and sent with CT-1's header names. Fire-and-forget
 * from the caller's side: given the sweep above, there's nothing useful to
 * do with a failure here beyond logging it.
 */
export async function reportTailnetKey(profile: Profile, nodeKey: string): Promise<void> {
  if (!profile.tailnetReportUrl || !profile.brokerNodeId) return;
  if (!inTauri()) return;

  try {
    const url = new URL(profile.tailnetReportUrl);
    const body = JSON.stringify({ nodeKey });
    const { ts, sig } = await invoke<SignResult>("tailnet_sidecar_sign", { method: "POST", path: url.pathname, body });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Node-Id": profile.brokerNodeId,
        "X-Node-Ts": String(ts),
        "X-Node-Sig": sig,
      },
      body,
    });
    if (!response.ok) console.error(`tailnet key report failed (${String(response.status)})`);
  } catch (err) {
    console.error("tailnet key report failed:", err);
  }
}

/** The `host:port` a grant tells the sidecar to dial inside the tailnet. */
export function grantTarget(grant: ConnectGrant): string {
  return `${grant.endpoint.host}:${String(grant.endpoint.port)}`;
}

export interface TailnetJoinPlan {
  target: string;
  /** Only set for a brokered profile — the grant's token, paired with this
   * same call, for a caller that's about to spend it on the connection this
   * join is for (never for a caller that only cares about the target, e.g.
   * `useTailnetSidecarOwner`, which has no connection of its own to open). */
  token?: string;
}

/**
 * Resolves what a tailnet profile's sidecar should dial to actually reach
 * the relay — a fresh broker grant's endpoint for a brokered profile
 * (its tailnet address can move after the relay restarts or migrates, so
 * this is never cached), or the static `tailnetTarget`/`connectToken` pair
 * for a profile configured by hand with no broker. Handing a different
 * target to an already-running sidecar restarts it there (see
 * `acquireTailnetSidecar`).
 * Precondition: `isTailnetProfile(profile)` — this throws for a profile
 * with neither a broker nor a static target instead of returning one.
 */
export async function resolveTailnetTarget(profile: Profile): Promise<TailnetJoinPlan> {
  if (!isBrokeredProfile(profile)) {
    if (!profile.tailnetTarget) throw new Error("tailnet profile has no target to dial (no tailnetTarget and no broker)");
    return { target: profile.tailnetTarget, token: profile.connectToken };
  }
  const grant = await fetchConnectGrant(profile);
  return { target: grantTarget(grant), token: grant.token };
}
