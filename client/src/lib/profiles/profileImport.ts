import { discoverPairingEndpoints, parsePairingCode } from "@/lib/profiles/pairingCode";
import { addProfile, getProfiles, type Profile } from "@/lib/profiles/profiles";
import { claimTailnetBundle } from "@/lib/profiles/tailnetClaim";

/**
 * Generic remote-profile import via a deep link:
 * `anywh://import-profile?label=&host=&port=&token=` (direct mode) or
 * `anywh://import-profile?label=&claimUrl=&joinCode=&brokerUrl=` (tailnet
 * mode). Nothing here is specific to any one hosted service
 * — it's the same shape a self-hoster could hand out for their own relay
 * (`host`/`port` to reach it directly, an optional `token` for a reverse
 * proxy gating access) or their own broker (a `claimUrl` to redeem a code
 * against, a `brokerUrl` to ask for connections afterward — CT-1).
 * `DEFAULT_PROFILES`'s own comment in profiles.ts already anticipated a
 * flow like this calling `addProfile`.
 *
 * `resolvePairingCodeParams` below is the same tailnet mode reached from a
 * typed `<join-code>@<host>` code instead of a link — it resolves the same
 * fields through discovery, without spending the code itself; the caller
 * hands the result to `claimAndSaveProfile` to actually redeem it.
 */
export interface ImportedProfileParams {
  label: string;
  host?: string;
  port?: number;
  connectToken?: string;
  claimUrl?: string;
  joinCode?: string;
  brokerUrl?: string;
}

const IMPORT_PROFILE_ACTION = "import-profile";

/**
 * Parses a deep link URL into import params, or `null` if it isn't a
 * recognized `anywh://import-profile` link, is missing `label`, or has
 * neither a complete direct-mode (`host`+`port`) nor tailnet-mode
 * (`claimUrl`+`joinCode`) set of fields. Pure — no side effect — so the
 * parsing itself is testable without touching
 * `profiles.ts`/`localStorage`/Tauri at all.
 *
 * `brokerUrl` is optional in tailnet mode: a link that names one pins it
 * (that's what anywh-app's dialog does, since its broker is per workspace
 * and the link is built where the workspace is known), and a link that
 * doesn't falls back to whatever the claim response carries. Either way the
 * value is opaque here — CT-1.
 */
export function parseImportProfileUrl(url: string): ImportedProfileParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "anywh:") return null;
  // A custom scheme has no real authority component — most URL parsers
  // (including this one) still put the part right after `://` into
  // `.hostname`, which is where `import-profile` lands here.
  if (parsed.hostname !== IMPORT_PROFILE_ACTION) return null;

  const params = parsed.searchParams;
  const label = params.get("label");
  if (!label) return null;

  const hostRaw = params.get("host");
  const portRaw = params.get("port");
  if (hostRaw && portRaw) {
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { label, host: hostRaw, port, connectToken: params.get("token") ?? undefined };
  }

  const claimUrl = params.get("claimUrl");
  const joinCode = params.get("joinCode");
  const brokerUrl = params.get("brokerUrl");
  if (claimUrl && joinCode) return { label, claimUrl, joinCode, brokerUrl: brokerUrl ?? undefined };

  return null;
}

export interface ClaimAndSaveResult {
  profile: Profile;
  /** Profiles that already reach the same machine — same `brokerNodeId` in
   * tailnet mode, same `host`:`relayPort` in direct mode — computed against
   * the list as it stood *before* this import's `addProfile`, so the new
   * profile never counts as its own duplicate. The caller decides what to
   * do about it (profileSetup.ts's `ready` state); this function only ever
   * saves, never rolls back — the code is already spent by the time this
   * runs. */
  duplicates: Profile[];
}

/**
 * Redeems `params` (the join code, for tailnet mode) and adds the resulting
 * profile to the local list (`addProfile`, profiles.ts), returning it
 * alongside any pre-existing duplicate. The id is always generated here
 * (not by any server) — for a tailnet-mode import this is still true even
 * though `claimTailnetBundle` does hit the network: that call registers
 * this *device* on the account, it never allocates a *local profile* id,
 * which has no server-side counterpart at all (same as `AddProfileDialog`'s
 * direct-mode flow never had one).
 */
export async function claimAndSaveProfile(params: ImportedProfileParams): Promise<ClaimAndSaveResult> {
  const id = crypto.randomUUID();
  if (params.claimUrl && params.joinCode) {
    const bundle = await claimTailnetBundle(params.claimUrl, params.joinCode);
    // Caller-supplied wins over claim-supplied: an explicit `brokerUrl` in
    // the link was chosen by whoever built the link, which is a stronger
    // statement than a server default.
    const brokerUrl = params.brokerUrl ?? bundle.brokerUrl;
    const duplicates = getProfiles().filter((p) => p.brokerNodeId === bundle.nodeId);
    const profile: Profile = {
      id,
      label: params.label,
      // Placeholder — useRelayClient (F2/F3) always replaces these with the
      // tailnet-sidecar's local address before ever opening a WebSocket; a
      // brokered profile never dials host/relayPort directly.
      host: "127.0.0.1",
      relayPort: 0,
      tailnetControlUrl: bundle.controlUrl,
      tailnetAuthKey: bundle.authKey,
      brokerUrl,
      brokerNodeId: bundle.nodeId,
      tailnetReportUrl: bundle.reportUrl,
      // Saved before it is reached — the pipeline's verify step (or the
      // shell's first session sync) is what clears this.
      unverified: true,
    };
    addProfile(profile);
    return { profile, duplicates };
  }
  const duplicates = getProfiles().filter((p) => p.host === params.host && p.relayPort === params.port);
  const profile: Profile = {
    id,
    label: params.label,
    host: params.host!,
    relayPort: params.port!,
    connectToken: params.connectToken,
    unverified: true,
  };
  addProfile(profile);
  return { profile, duplicates };
}

/** Thin wrapper kept for call sites that only ever want the id and never
 * care about a duplicate (the deep-link path pre-profileSetup.ts, and
 * `profileImport.test.ts`'s existing coverage). */
export async function importProfile(params: ImportedProfileParams): Promise<string> {
  const { profile } = await claimAndSaveProfile(params);
  return profile.id;
}

/**
 * The typed-code counterpart of a tailnet-mode deep link: resolves
 * `<join-code>@<host>` through the host's own discovery document
 * (pairingCode.ts) into the same `ImportedProfileParams` shape a deep link
 * would carry, so both entry points converge on one redemption path
 * (`claimAndSaveProfile`).
 *
 * Split out from redemption because the two differ in exactly one thing —
 * where `claimUrl` comes from — and this half is the only part that can
 * fail before any code is spent. Rejecting a malformed code here means a
 * mistyped one never reaches the network, and so never burns one of the
 * five attempts the code allows.
 */
export async function resolvePairingCodeParams(label: string, code: string): Promise<ImportedProfileParams> {
  const parsed = parsePairingCode(code);
  if (!parsed) throw new Error("malformed pairing code");
  const endpoints = await discoverPairingEndpoints(parsed.origin);
  return { label, claimUrl: endpoints.claimUrl, joinCode: parsed.joinCode, brokerUrl: endpoints.brokerUrl };
}
