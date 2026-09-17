import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "@/lib/platform/tauri";
import { currentPlatform } from "@/lib/platform/platform";

export interface ClaimedBundle {
  nodeId: string;
  controlUrl: string;
  authKey: string;
  /** Opaque — where to report the tsnet node key this device earns on its
   * next join. Optional so a self-hoster's own
   * claim endpoint that doesn't implement the report step still works;
   * `importProfile` (profileImport.ts) just leaves `Profile.tailnetReportUrl`
   * unset when absent. */
  reportUrl?: string;
  /** Opaque — where to ask for a fresh connection before every dial (the
   * CT-1 broker contract, `Profile.brokerUrl`). Optional for two independent
   * reasons: a self-hoster's claim endpoint may have no broker at all, and
   * an `anywh://import-profile` link can name the broker itself, in which
   * case the link's value is the one that stands (profileImport.ts). It
   * exists here because a *typed* pairing code (pairingCode.ts) has nowhere
   * else to learn it — a code carries only a host, and the broker is
   * generally scoped to whatever the code was minted for, which only the
   * claim can resolve. */
  brokerUrl?: string;
}

/**
 * Redeems a one-time join code against a generic `claimUrl` — supplied by
 * a deep link or discovered from the host half of a typed
 * pairing code (pairingCode.ts) — generates (or loads, if this device already
 * paired once before) this device's own Ed25519 identity first
 * (`tailnet_sidecar_identity`, F2) and sends only its public half; the
 * private key never leaves the device, and never transits through the deep
 * link at all. Generic on the same terms as `fetchConnectGrant`
 * (tailnetBroker.ts): the response is interpreted as
 * `{nodeId, controlUrl, authKey, ...}`, anything else (`proxyListenPort`,
 * `signingKeys` — control-plane-internal, meaningless to this client) is
 * ignored. `platform` (this device's OS, `lib/platform.ts`) rides along as
 * a plain descriptive field, same category as the label a self-hoster's own
 * claim endpoint is free to ignore — it never shapes what this function
 * does with the response.
 */
export async function claimTailnetBundle(claimUrl: string, joinCode: string): Promise<ClaimedBundle> {
  if (!inTauri()) {
    throw new Error("claiming a tailnet profile needs the Tauri sidecar to generate an identity, not available in a plain browser");
  }
  const publicKey = await invoke<string>("tailnet_sidecar_identity");
  const platform = currentPlatform();

  const response = await fetch(claimUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ joinCode, publicKey, ...(platform ? { platform } : {}) }),
  });
  if (!response.ok) throw new Error(`claim failed (${String(response.status)})`);
  const body = (await response.json()) as Partial<ClaimedBundle>;
  if (!body.nodeId || !body.controlUrl || !body.authKey) {
    throw new Error("claim response missing nodeId/controlUrl/authKey");
  }
  return {
    nodeId: body.nodeId,
    controlUrl: body.controlUrl,
    authKey: body.authKey,
    reportUrl: body.reportUrl,
    brokerUrl: body.brokerUrl,
  };
}
