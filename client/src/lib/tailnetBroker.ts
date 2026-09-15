import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/tauri";
import { isBrokeredProfile, type Profile } from "@/lib/profiles";

export interface ConnectGrant {
  endpoint: { host: string; port: number };
  token: string;
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

  constructor(retryAfterMs?: number) {
    super("the broker is refusing new connections for this account right now (throttled or out of quota)");
    this.name = "BrokerThrottledError";
    this.retryAfterMs = retryAfterMs;
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
export async function fetchConnectGrant(profile: Profile): Promise<ConnectGrant> {
  if (!isBrokeredProfile(profile)) throw new Error("profile has no broker configured");
  if (!inTauri()) throw new Error("the broker call needs the Tauri sidecar to sign it, not available in a plain browser");

  const url = new URL(profile.brokerUrl!);
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
      const hint = (await response.json().catch(() => ({}))) as { retry_after_ms?: number };
      if (Date.now() >= deadline) {
        throw new Error("broker is still resuming the compute after waiting for it");
      }
      await delay(hint.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS);
      continue;
    }
    if (!response.ok) {
      if (response.status === 410) throw new BrokerRevokedError();
      if (response.status === 429) {
        const hint = (await response.json().catch(() => ({}))) as { retry_after_ms?: number };
        throw new BrokerThrottledError(hint.retry_after_ms);
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
 * for a profile configured by hand with no broker. Only meaningful for
 * starting a *cold* join: an already-running sidecar keeps forwarding to
 * whatever target its first caller resolved (see `acquireTailnetSidecar`'s
 * doc comment) — a caller reusing that sidecar still needs its own fresh
 * token, separately, for whichever connection it's about to open.
 * Precondition: `isTailnetProfile(profile)` — this throws for a profile
 * with neither a broker nor a static target instead of returning one.
 */
export async function resolveTailnetTarget(profile: Profile): Promise<TailnetJoinPlan> {
  if (!isBrokeredProfile(profile)) {
    if (!profile.tailnetTarget) throw new Error("tailnet profile has no target to dial (no tailnetTarget and no broker)");
    return { target: profile.tailnetTarget, token: profile.connectToken };
  }
  const grant = await fetchConnectGrant(profile);
  return { target: `${grant.endpoint.host}:${String(grant.endpoint.port)}`, token: grant.token };
}
