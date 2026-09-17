/**
 * Self-describing pairing codes — `<join-code>@<host>` (e.g.
 * `ABCDEF-GHJKMNPQ@example.com`), the typed counterpart of the
 * `anywh://import-profile` deep link (profileImport.ts).
 *
 * Why the host is part of the code at all: a bare join code is meaningless
 * without knowing *where* to redeem it, and this client is not allowed to
 * know that — the whole point of the deep link carrying `claimUrl` as
 * opaque data is that no route of any particular hosted
 * service is ever hardcoded here. Baking a host in as the only alternative
 * would hardcode one deployment into a self-hostable client. So the code
 * carries its own host, and the host says where its endpoints are, via the
 * discovery document below.
 *
 * The host stays visible in plaintext on purpose: whoever types the code
 * can see which machine is about to receive their device's public key.
 */

/**
 * Where a host publishes its pairing endpoints. This path is part of *this
 * project's* protocol, not any one deployment's API — a self-hoster serves
 * a static JSON file here and their own relay is reachable by pairing code,
 * with no code change on either side. That direction matters: a hosted
 * service conforms to this spec, this client never learns that service's
 * own route names.
 */
export const WELL_KNOWN_PAIRING_PATH = "/.well-known/anywh-pairing";

export interface ParsedPairingCode {
  /** The secret half, passed through to the claim endpoint untouched. */
  joinCode: string;
  /** Origin to fetch the discovery document from, scheme included. */
  origin: string;
}

export interface PairingEndpoints {
  /** Where to POST `{joinCode, publicKey}` — see `claimTailnetBundle`. */
  claimUrl: string;
  /** Optional: a host whose broker is the same for every device it pairs
   * can name it here. A host that resolves the broker per claimed device
   * (which is the interesting case, since the broker is usually scoped to
   * whatever the code was minted for) returns it from the claim response
   * instead, and leaves this absent. */
  brokerUrl?: string;
}

/**
 * Loopback keeps `http` so a self-hoster can pair against a relay they're
 * running on the same machine. Everything else is forced to `https`: the
 * join code and this device's public key both cross the wire on the way to
 * the claim endpoint, and downgrading that on a typo is not a trade this
 * should silently make.
 */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Parses `<join-code>@<host>` into its two halves, or returns `null` if it
 * isn't one. Pure — no network, no storage — so the dialog can validate
 * what was typed before trying to redeem anything.
 *
 * Tolerant of how people actually paste: surrounding whitespace, a
 * lowercased code (the mint emits uppercase Crockford base32, which has no
 * lowercase forms to confuse it with), and an explicit `http://`/`https://`
 * in front of the host are all accepted.
 */
export function parsePairingCode(raw: string): ParsedPairingCode | null {
  const trimmed = raw.trim();
  // Last `@`, not first: the host can't contain one, but this way a code
  // that somehow does is still split at the right place.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const joinCode = trimmed.slice(0, at).toUpperCase();
  const hostPart = trimmed.slice(at + 1);
  if (/\s/.test(joinCode) || /\s/.test(hostPart)) return null;

  let parsed: URL;
  try {
    parsed = new URL(hostPart.includes("://") ? hostPart : `https://${hostPart}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  // A host, optionally with a port — anything past that (a path, a query)
  // isn't a host and is more likely a mangled paste than intent. Embedded
  // credentials need no check of their own: they'd have to carry an `@`,
  // and splitting at the *last* one above already puts everything before it
  // in the code half, where the worst case is a code that fails to redeem.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;

  const protocol = isLoopback(parsed.hostname) ? parsed.protocol : "https:";
  return { joinCode, origin: `${protocol}//${parsed.host}` };
}

/**
 * Fetches the host's discovery document and returns the endpoints it names.
 * Throws (rather than returning null) because every failure here is
 * something the person pairing needs to see: a host that doesn't publish
 * the document isn't pairable, and saying so beats a silent dead end.
 *
 * Only `claimUrl`/`brokerUrl` are read; a document carrying anything else
 * is fine and ignored, same tolerance as `claimTailnetBundle`'s reading of
 * the claim response.
 */
export async function discoverPairingEndpoints(origin: string): Promise<PairingEndpoints> {
  const response = await fetch(`${origin}${WELL_KNOWN_PAIRING_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`pairing discovery failed (${String(response.status)})`);

  const body = (await response.json()) as Partial<PairingEndpoints>;
  if (!body.claimUrl) throw new Error("pairing discovery document has no claimUrl");
  // A document is data fetched from the network, so its URLs get the same
  // scheme check the typed host got — otherwise the check above would be
  // one indirection away from meaningless.
  assertSafeUrl(body.claimUrl, "claimUrl");
  if (body.brokerUrl) assertSafeUrl(body.brokerUrl, "brokerUrl");

  return { claimUrl: body.claimUrl, brokerUrl: body.brokerUrl };
}

function assertSafeUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`pairing discovery document has a malformed ${field}`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return;
  throw new Error(`pairing discovery document has a non-https ${field}`);
}
