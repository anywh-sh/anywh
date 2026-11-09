import type { AddressClass, ConnectFailureReason } from "@/lib/telemetry/events";

/**
 * What a failed connection attempt reduces to before it is counted: the kind
 * of address that was dialled and a coarse reason. Both exist so the funnel
 * can tell "typed a LAN address the relay does not listen on" from "the
 * pairing service was down" without a host, port or message ever leaving the
 * app.
 */

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

/** Eight 16-bit groups, or `null` when `host` is not an IPv6 literal. */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...Array<number>(missing).fill(0), ...tail] : null;
}

function classifyIpv4([a, b]: [number, number, number, number]): AddressClass {
  if (a === 127 || a === 0) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "tailscale";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private_lan";
  return "public";
}

function classifyIpv6(groups: number[]): AddressClass {
  const [first, second, third] = groups;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothes.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return classifyIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  // Tailscale's own ULA range, inside fc00::/7 — checked first.
  if (first === 0xfd7a && second === 0x115c && third === 0xa1e0) return "tailscale";
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return "private_lan";
  return "public";
}

/**
 * The kind of address a connection was dialled to — never the address.
 * `brokered` is for profiles that reach the machine through the tailnet
 * sidecar (a pairing code): the stored host of those is a placeholder, so
 * what it looks like says nothing about where the traffic went. Link-local
 * IPv4 (169.254/16) counts as a private LAN address, like its IPv6 sibling.
 */
export function addressClassOf(host: string, brokered = false): AddressClass {
  if (brokered) return "brokered";
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  name = name.replace(/%.*$/, "").replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  if (name.endsWith(".ts.net")) return "tailscale";
  const v4 = parseIpv4(name);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(name);
  if (v6) return classifyIpv6(v6);
  return "hostname";
}

/**
 * A coarse reason from what the error says. A browser `fetch` that never got
 * an answer rejects with a bare `TypeError` whether the port was closed, the
 * host asleep or the network gone, so that is `unreachable`, not `refused`:
 * `refused` and `timeout` only appear when the error text itself (a sidecar
 * dial failure, say) names them. Anything else is `other` rather than a guess.
 */
export function connectFailureReasonOf(error: unknown): ConnectFailureReason {
  // By name: the broker's own class would drag the whole broker module into
  // this pure file.
  if (error instanceof Error && error.name === "BrokerRevokedError") return "auth";
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/\((401|403)\)/.test(text)) return "auth";
  if (/connection refused|econnrefused/i.test(text)) return "refused";
  if (/timed? ?out|timeout|deadline exceeded|etimedout/i.test(text)) return "timeout";
  if (/unreachable|enotfound|getaddrinfo|no route to host|no such host|failed to fetch|load failed|networkerror/i.test(text)) return "unreachable";
  if (error instanceof TypeError) return "unreachable";
  return "other";
}
