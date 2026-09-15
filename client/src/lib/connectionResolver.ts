import { fetchConnectGrant, resolveTailnetTarget, type GrantOptions } from "@/lib/tailnetBroker";
import { acquireTailnetSidecar, peekTailnetSidecar, releaseTailnetSidecar } from "@/lib/tailnetSidecar";
import { isBrokeredProfile, isTailnetProfile, type Profile } from "@/lib/profiles";

export interface ResolvedConnection {
  host: string;
  port: number;
  token?: string;
}

/**
 * Turns a `Profile` into something a hook/module outside the chat WebSocket
 * can actually dial — the single place every one of them (sidebar, files,
 * terminal, theme/profile sync) goes through instead of reading
 * `profile.host`/`profile.relayPort` straight (any traffic that isn't the
 * chat's own WebSocket). A direct profile resolves from its own
 * fields, synchronously in spirit (wrapped in a promise only for one
 * call-site shape). A tailnet profile needs two independent things:
 *
 * - The sidecar's local address — peeked from whichever owner already has
 *   it running (`useTailnetSidecarOwner` at the App level, or a chat tab's
 *   `useRelayClient`), never re-acquired here: an acquire+release around
 *   every call would tear the join down between calls whenever nothing else
 *   holds a reference, refiring the whole `tsnet` join on the next one
 *   (tens of seconds). Only when nobody already owns it (e.g. a
 *   tailnet profile queried one-off, like `useAllSessionNames`'s
 *   cross-profile search) does this fall back to acquiring just for the
 *   call and releasing right after.
 * - A brand-new broker grant for the token — never reused:
 *   the control plane's proxy spends every connect token's `jti` on the first request of
 *   the TCP connection it authorizes, so
 *   every new connection through the tunnel needs its own unspent one.
 */
export async function resolveConnection(profile: Profile, options?: GrantOptions): Promise<ResolvedConnection> {
  if (!isTailnetProfile(profile)) {
    return { host: profile.host, port: profile.relayPort, token: profile.connectToken };
  }

  const peeked = peekTailnetSidecar(profile.id);
  if (peeked) {
    const [endpoint, token] = await Promise.all([peeked, resolveFreshToken(profile, options)]);
    return { host: endpoint.host, port: endpoint.port, token };
  }

  const plan = await resolveTailnetTarget(profile);
  try {
    const endpoint = await acquireTailnetSidecar(profile, plan.target);
    return { host: endpoint.host, port: endpoint.port, token: plan.token };
  } finally {
    releaseTailnetSidecar(profile.id);
  }
}

async function resolveFreshToken(profile: Profile, options?: GrantOptions): Promise<string | undefined> {
  if (!isBrokeredProfile(profile)) return profile.connectToken;
  return (await fetchConnectGrant(profile, options)).token;
}

/** `fetch` headers carrying a connect token, when there is one — a direct
 * profile behind no reverse-proxy credential and a tailnet profile that
 * hasn't resolved yet both have none, and an empty object is a valid,
 * no-op `HeadersInit`. The proxy accepts this same value via
 * `X-Anywh-Connect-Token`/query param too (`bearerToken`,
 * `edge/internal/proxy/server.go`), but `Authorization: Bearer` needs no
 * URL-encoding and works uniformly for every HTTP method used here. */
export function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
