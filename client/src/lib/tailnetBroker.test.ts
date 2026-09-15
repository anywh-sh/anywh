import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: unknown) => ({ ts: Date.now(), sig: `sig-${String(Date.now())}` })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/tauri", () => ({ inTauri: () => true }));

import { BrokerAsleepError, BrokerThrottledError, fetchConnectGrant, reportTailnetKey, resolveTailnetTarget } from "@/lib/tailnetBroker";

const profile: Profile = {
  id: "p1",
  label: "Sandbox",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  brokerUrl: "https://api.test/v1/connect/w1",
  brokerNodeId: "node-1",
};

const staticProfile: Profile = {
  id: "p2",
  label: "Manual",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.9:9000",
  connectToken: "static-token",
};

function resuming(): Response {
  return new Response(JSON.stringify({ state: "resuming", retry_after_ms: 1500, eta_ms: 5000 }), { status: 409 });
}

function granted(): Response {
  return new Response(JSON.stringify({ endpoint: { host: "100.64.0.1", port: 8443 }, token: "tok" }), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchConnectGrant", () => {
  it("waits out a broker that answers 409 'resuming' and takes the grant when it comes", async () => {
    // The compute this profile points at was suspended (its sandbox died and
    // the control plane reconciled it), so the first attempts land while the
    // resume is still in flight.
    const fetchMock = vi.fn().mockResolvedValueOnce(resuming()).mockResolvedValueOnce(resuming()).mockResolvedValueOnce(granted());
    vi.stubGlobal("fetch", fetchMock);

    const grant = fetchConnectGrant(profile);
    await vi.runAllTimersAsync();

    expect(await grant).toEqual({ endpoint: { host: "100.64.0.1", port: 8443 }, token: "tok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every attempt has to carry its own signature — the control plane's
    // anti-replay check rejects a repeated one, so a retry that
    // reused the first would fail for a reason that has nothing to do with
    // the resume.
    const signCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "tailnet_sidecar_sign");
    expect(signCalls).toHaveLength(3);
    const signatures = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(new Set(signatures.map((h) => h["X-Node-Sig"])).size).toBe(3);
  });

  it("gives up once the resume has clearly not happened", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resuming()));

    const grant = fetchConnectGrant(profile);
    const assertion = expect(grant).rejects.toThrow(/resum/i);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("sends wake=false only when asked, and stops waiting on the 'suspended' 409 it gets back", async () => {
    // Without this, the resuming-409 loop above would spend its full two
    // minute deadline waiting for a resume that was never scheduled — the
    // caller explicitly asked for none.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: "suspended" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    const grant = fetchConnectGrant(profile, { wake: false });
    const assertion = expect(grant).rejects.toBeInstanceOf(BrokerAsleepError);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("wake=false");
  });

  it("never sends the parameter at all by default", async () => {
    // A broker that doesn't know it would ignore it anyway, but not sending
    // it keeps the default request byte-identical to what every existing
    // self-hosted broker already answers.
    const fetchMock = vi.fn().mockResolvedValue(granted());
    vi.stubGlobal("fetch", fetchMock);

    await fetchConnectGrant(profile);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("wake");
  });

  it("surfaces a 429 as its own error instead of a generic refusal, so callers can slow down", async () => {
    // The outer reconnect loops (relayClient, useSessionNames) treat any
    // thrown error as transient and retry within seconds — against an
    // account that is out of quota, that is an endless hot loop against the
    // one endpoint already saying "stop".
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "allowance_exhausted" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const grant = fetchConnectGrant(profile);
    const assertion = expect(grant).rejects.toBeInstanceOf(BrokerThrottledError);
    await vi.runAllTimersAsync();
    await assertion;
    // Refused, never retried inside the call — a 429 is not a 409.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the broker's own retry hint when it offers one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ retry_after_ms: 90_000 }), { status: 429 })));

    const grant = fetchConnectGrant(profile);
    const assertion = expect(grant).rejects.toMatchObject({ retryAfterMs: 90_000 });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("still fails immediately on a refusal that is not a resume", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));

    const grant = fetchConnectGrant(profile);
    const assertion = expect(grant).rejects.toThrow(/403/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("reportTailnetKey", () => {
  const reportableProfile: Profile = { ...profile, tailnetReportUrl: "https://api.test/v1/nodes/node-1/tailnet" };

  it("signs and posts the node key with CT-1's generic headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await reportTailnetKey(reportableProfile, "nodekey:abc");

    expect(invokeMock).toHaveBeenCalledWith("tailnet_sidecar_sign", {
      method: "POST",
      path: "/v1/nodes/node-1/tailnet",
      body: JSON.stringify({ nodeKey: "nodekey:abc" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.test/v1/nodes/node-1/tailnet");
    expect(init.body).toBe(JSON.stringify({ nodeKey: "nodekey:abc" }));
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Node-Id"]).toBe("node-1");
    expect(headers["X-Node-Sig"]).toBeTruthy();
  });

  it("is a no-op for a profile with no tailnetReportUrl (manually configured, nothing to report to)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await reportTailnetKey(staticProfile, "nodekey:abc");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("swallows a failed report instead of throwing — the hourly reconciliation sweep is the fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(reportTailnetKey(reportableProfile, "nodekey:abc")).resolves.toBeUndefined();
  });
});

describe("resolveTailnetTarget", () => {
  it("resolves a brokered profile's target (and token) from a fresh grant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(granted()));
    await expect(resolveTailnetTarget(profile)).resolves.toEqual({ target: "100.64.0.1:8443", token: "tok" });
  });

  it("resolves a static profile's target/token straight from its own fields, no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveTailnetTarget(staticProfile)).resolves.toEqual({
      target: "100.64.0.9:9000",
      token: "static-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws for a profile with neither a broker nor a static target", async () => {
    const misconfigured: Profile = { ...staticProfile, tailnetTarget: undefined };
    await expect(resolveTailnetTarget(misconfigured)).rejects.toThrow(/no target to dial/);
  });
});
