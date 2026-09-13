import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProfiles, setProfiles } from "@/lib/profiles";

const {
  claimTailnetBundleMock,
  discoverPairingEndpointsMock,
  acquireTailnetSidecarMock,
  releaseTailnetSidecarMock,
  peekTailnetSidecarMock,
  resolveTailnetTargetMock,
  fetchConnectGrantMock,
  fetchSessionsMock,
  fetchControlProfilesMock,
} = vi.hoisted(() => ({
  claimTailnetBundleMock: vi.fn(),
  discoverPairingEndpointsMock: vi.fn(),
  acquireTailnetSidecarMock: vi.fn(),
  releaseTailnetSidecarMock: vi.fn(),
  peekTailnetSidecarMock: vi.fn(),
  resolveTailnetTargetMock: vi.fn(),
  fetchConnectGrantMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  fetchControlProfilesMock: vi.fn(),
}));

vi.mock("@/lib/tailnetClaim", () => ({ claimTailnetBundle: claimTailnetBundleMock }));
// parsePairingCode stays real (pure, no network) — only discovery is mocked.
vi.mock("@/lib/pairingCode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pairingCode")>();
  return { ...actual, discoverPairingEndpoints: discoverPairingEndpointsMock };
});
vi.mock("@/lib/tailnetSidecar", () => ({
  acquireTailnetSidecar: acquireTailnetSidecarMock,
  releaseTailnetSidecar: releaseTailnetSidecarMock,
  peekTailnetSidecar: peekTailnetSidecarMock,
}));
vi.mock("@/lib/tailnetBroker", () => ({
  resolveTailnetTarget: resolveTailnetTargetMock,
  fetchConnectGrant: fetchConnectGrantMock,
}));
vi.mock("@/lib/relayClient", () => ({
  fetchSessions: fetchSessionsMock,
  fetchControlProfiles: fetchControlProfilesMock,
}));

import {
  completeProfileSetup,
  dismissProfileSetup,
  dropQueuedProfileSetup,
  enqueueProfileSetup,
  getProfileSetupState,
  HANDOVER_GRACE_MS,
  holdProfileSetup,
  resumeProfileSetup,
  retryProfileSetup,
  __resetProfileSetupForTests,
  type SetupRequest,
} from "./profileSetup";

function tailnetRequest(overrides: { claimUrl?: string; joinCode?: string; brokerUrl?: string } = {}): SetupRequest {
  return {
    source: "params",
    params: {
      label: "Device",
      claimUrl: overrides.claimUrl ?? "https://api.test/claim",
      joinCode: overrides.joinCode ?? "CODE-1",
      brokerUrl: overrides.brokerUrl,
    },
  };
}

function directRequest(overrides: { host?: string; port?: number } = {}): SetupRequest {
  return {
    source: "params",
    params: { label: "Direct", host: overrides.host ?? "1.2.3.4", port: overrides.port ?? 8443 },
  };
}

function pairingRequest(code: string): SetupRequest {
  return { source: "pairingCode", label: "Device", code };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();

  claimTailnetBundleMock.mockReset().mockResolvedValue({
    nodeId: "node-default",
    controlUrl: "https://ctrl.test",
    authKey: "key",
    brokerUrl: "https://broker.test/w1",
  });
  discoverPairingEndpointsMock.mockReset().mockResolvedValue({ claimUrl: "https://example.test/claim", brokerUrl: undefined });
  resolveTailnetTargetMock.mockReset().mockResolvedValue({ target: "100.64.0.1:8443", token: "connect-token" });
  acquireTailnetSidecarMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 55555 });
  releaseTailnetSidecarMock.mockReset();
  peekTailnetSidecarMock.mockReset().mockReturnValue(Promise.resolve({ host: "127.0.0.1", port: 55555 }));
  fetchConnectGrantMock.mockReset().mockResolvedValue({ endpoint: { host: "100.64.0.1", port: 8443 }, token: "fresh-token" });
  fetchSessionsMock.mockReset().mockResolvedValue([]);
  fetchControlProfilesMock.mockReset().mockResolvedValue([]);
});

describe("profileSetup", () => {
  it("runs the tailnet pipeline through claim, connect, and verify to ready", async () => {
    fetchSessionsMock.mockResolvedValue([{ id: "s1", title: "Hello" }]);

    expect(enqueueProfileSetup(tailnetRequest())).toBe(true);
    // Synchronously claiming right after enqueue — nothing here has awaited yet.
    expect(getProfileSetupState().state).toEqual({ status: "claiming", mode: "tailnet" });

    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    expect(state?.status).toBe("ready");
    if (state?.status !== "ready") throw new Error("unreachable");
    expect(state.mode).toBe("tailnet");
    expect(state.info).toEqual({ sessionCount: 1 });
    expect(state.duplicates).toEqual([]);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
    expect(acquireTailnetSidecarMock).toHaveBeenCalledTimes(1);
    expect(getProfiles().find((p) => p.id === state.profile.id)).toBeDefined();
  });

  it("runs the direct pipeline with connect as a no-op", async () => {
    expect(enqueueProfileSetup(directRequest())).toBe(true);
    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    expect(state?.status).toBe("ready");
    if (state?.status !== "ready") throw new Error("unreachable");
    expect(state.mode).toBe("direct");
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();
    expect(acquireTailnetSidecarMock).not.toHaveBeenCalled();
  });

  it("resolves a typed pairing code into params and reaches ready", async () => {
    expect(enqueueProfileSetup(pairingRequest("ABCDEF-GHJKMNPQ@example.test"))).toBe(true);
    await vi.runAllTimersAsync();

    expect(discoverPairingEndpointsMock).toHaveBeenCalledWith("https://example.test");
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("dedups the same tailnet link enqueued twice — claimTailnetBundle runs exactly once", async () => {
    const request = tailnetRequest({ claimUrl: "https://api.test/claim-a", joinCode: "CODE-A" });

    expect(enqueueProfileSetup(request)).toBe(true);
    expect(enqueueProfileSetup(request)).toBe(false);

    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("dedups a typed pairing code before discovery ever runs", async () => {
    const code = "ABCDEF-GHJKMNPQ@example.test";

    expect(enqueueProfileSetup(pairingRequest(code))).toBe(true);
    expect(enqueueProfileSetup(pairingRequest(code))).toBe(false);

    await vi.runAllTimersAsync();
    expect(discoverPairingEndpointsMock).toHaveBeenCalledTimes(1);
  });

  it("survives an app restart — a redeemed link is never re-claimed after the module reloads", async () => {
    const request = tailnetRequest({ claimUrl: "https://api.test/restart", joinCode: "RESTART-CODE" });

    expect(enqueueProfileSetup(request)).toBe(true);
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);

    // Simulates a real app restart: a fresh module instance (its in-memory
    // dedup Set starts empty) re-reading whatever `localStorage` — the one
    // thing that actually survives a restart — was left with.
    vi.resetModules();
    const restarted = await import("./profileSetup");
    expect(restarted.enqueueProfileSetup(request)).toBe(false);
    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("processes the queue strictly serially — the next request waits for the current one to be dismissed or completed", async () => {
    const requestA = tailnetRequest({ claimUrl: "https://api.test/a", joinCode: "A" });
    const requestB = tailnetRequest({ claimUrl: "https://api.test/b", joinCode: "B" });

    enqueueProfileSetup(requestA);
    enqueueProfileSetup(requestB);
    expect(getProfileSetupState().queuedCount).toBe(1);

    await vi.runAllTimersAsync();
    // A reached ready; B must not have started yet even though A is just sitting there.
    expect(getProfileSetupState().state?.status).toBe("ready");
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetupState().queuedCount).toBe(1);

    completeProfileSetup();
    await vi.runAllTimersAsync();

    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(2);
    expect(getProfileSetupState().queuedCount).toBe(0);
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("a claim failure adds no profile and frees the dedup key only once dismissed", async () => {
    claimTailnetBundleMock.mockRejectedValueOnce(new Error("claim failed"));
    const request = tailnetRequest({ claimUrl: "https://api.test/fail", joinCode: "FAIL" });

    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    expect(getProfileSetupState().state).toEqual({ status: "failed", mode: "tailnet", stage: "claim" });
    expect(getProfiles()).toHaveLength(0);

    // Still reserved before dismiss — a StrictMode-style replay of the same
    // link must not start a second claim.
    expect(enqueueProfileSetup(request)).toBe(false);

    dismissProfileSetup();
    expect(getProfileSetupState().state).toBeNull();

    expect(enqueueProfileSetup(request)).toBe(true);
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("a connect failure keeps the saved profile, releases the sidecar once, and retry never re-claims", async () => {
    acquireTailnetSidecarMock.mockRejectedValueOnce(new Error("join failed"));
    const request = tailnetRequest({ claimUrl: "https://api.test/connect-fail", joinCode: "CONNECT-FAIL" });

    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    const failedState = getProfileSetupState().state;
    expect(failedState?.status).toBe("failed");
    if (failedState?.status !== "failed" || failedState.stage === "claim") throw new Error("expected a connect failure");
    const savedId = failedState.profile.id;
    expect(getProfiles().find((p) => p.id === savedId)).toBeDefined();
    expect(releaseTailnetSidecarMock).toHaveBeenCalledTimes(1);
    expect(releaseTailnetSidecarMock).toHaveBeenCalledWith(savedId);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);

    retryProfileSetup();
    await vi.runAllTimersAsync();

    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1); // never re-claimed
    expect(releaseTailnetSidecarMock).toHaveBeenCalledTimes(1); // no extra release on the successful retry
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("reaches ready even when fetchControlProfiles rejects (older relay, no /control/profiles route)", async () => {
    fetchControlProfilesMock.mockRejectedValueOnce(new Error("404"));
    const request = tailnetRequest({ claimUrl: "https://api.test/old-relay", joinCode: "OLD" });

    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("completeProfileSetup releases the held sidecar with HANDOVER_GRACE_MS", async () => {
    const request = tailnetRequest({ claimUrl: "https://api.test/complete", joinCode: "COMPLETE" });
    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    if (state?.status !== "ready") throw new Error("expected ready");

    completeProfileSetup();
    expect(releaseTailnetSidecarMock).toHaveBeenCalledWith(state.profile.id, HANDOVER_GRACE_MS);
  });

  it("dismissProfileSetup releases the held sidecar immediately (no grace)", async () => {
    const request = tailnetRequest({ claimUrl: "https://api.test/dismiss", joinCode: "DISMISS" });
    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    if (state?.status !== "ready") throw new Error("expected ready");

    dismissProfileSetup();
    expect(releaseTailnetSidecarMock).toHaveBeenCalledWith(state.profile.id, 0);
  });

  it("flags a duplicate by brokerNodeId in tailnet mode", async () => {
    setProfiles([
      {
        id: "existing",
        label: "Existing",
        host: "127.0.0.1",
        relayPort: 0,
        brokerNodeId: "node-default",
        brokerUrl: "https://broker.test/w1",
        tailnetAuthKey: "key",
        tailnetControlUrl: "https://ctrl.test",
      },
    ]);

    const request = tailnetRequest({ claimUrl: "https://api.test/dup", joinCode: "DUP" });
    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    if (state?.status !== "ready") throw new Error("expected ready");
    expect(state.duplicates.map((p) => p.id)).toEqual(["existing"]);
  });

  it("flags a duplicate by host:port in direct mode", async () => {
    setProfiles([{ id: "existing", label: "Existing", host: "1.2.3.4", relayPort: 8443 }]);

    const request = directRequest({ host: "1.2.3.4", port: 8443 });
    enqueueProfileSetup(request);
    await vi.runAllTimersAsync();

    const state = getProfileSetupState().state;
    if (state?.status !== "ready") throw new Error("expected ready");
    expect(state.duplicates.map((p) => p.id)).toEqual(["existing"]);
  });
});

describe("dedup key lifetime", () => {
  it("frees a direct-mode key once the request settles, so the same machine can be added again after its profile is removed", async () => {
    // Nothing single-use is spent reaching a host:port directly, so the
    // reservation only has to outlive the request itself. Before this, the
    // persisted key made a second enqueue for the same address a silent
    // no-op forever — reachable from the first-run screen by removing the
    // only profile and connecting to the same machine again.
    expect(enqueueProfileSetup(directRequest())).toBe(true);
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");
    completeProfileSetup();
    await vi.runAllTimersAsync();

    expect(enqueueProfileSetup(directRequest())).toBe(true);
  });

  it("keeps a tailnet key reserved after completion — that code was spent", async () => {
    expect(enqueueProfileSetup(tailnetRequest())).toBe(true);
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");
    completeProfileSetup();
    await vi.runAllTimersAsync();

    expect(enqueueProfileSetup(tailnetRequest())).toBe(false);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });
});

describe("reserved vs spent", () => {
  it("a link the app died on before the claim is redeemable again after a restart", async () => {
    // The old single-stage guard persisted the reservation at enqueue, so a
    // link killed pre-network was dead for good, with no error. Only what
    // was actually redeemed survives a restart now.
    claimTailnetBundleMock.mockImplementationOnce(() => new Promise(() => {}));
    const request = tailnetRequest({ claimUrl: "https://api.test/died", joinCode: "DIED" });
    expect(enqueueProfileSetup(request)).toBe(true);
    // Discovery is synchronous for params; give the claim a tick to be
    // reached (it hangs forever, simulating the kill).
    await Promise.resolve();

    vi.resetModules();
    const restarted = await import("./profileSetup");
    // The key *was* marked spent — the claim was about to run — so on this
    // device it is not re-enqueued blindly...
    expect(restarted.enqueueProfileSetup(request)).toBe(false);
  });

  it("a reservation that never reached the claim is not persisted", async () => {
    // Held: the request sits in the queue, pre-network. A restart forgets
    // it, and the same link is accepted again.
    holdProfileSetup();
    const request = tailnetRequest({ claimUrl: "https://api.test/queued", joinCode: "QUEUED" });
    expect(enqueueProfileSetup(request)).toBe(true);
    expect(enqueueProfileSetup(request)).toBe(false);
    // Never released: the app dies with the link still waiting. A fresh
    // module (the next launch) has no memory of the reservation.
    vi.resetModules();
    const restarted = await import("./profileSetup");
    expect(restarted.enqueueProfileSetup(request)).toBe(true);
  });

  it("still reads the legacy flat array as spent, and keeps writing it for a downgrade", async () => {
    // An install upgrading from the flat array has only the old key.
    localStorage.removeItem("anywh:profileSetup:keys");
    localStorage.setItem("anywh:profileSetup:redeemedKeys", JSON.stringify(["tailnet:https://api.test/legacy|OLD"]));
    vi.resetModules();
    const fresh = await import("./profileSetup");
    expect(fresh.enqueueProfileSetup(tailnetRequest({ claimUrl: "https://api.test/legacy", joinCode: "OLD" }))).toBe(false);

    expect(fresh.enqueueProfileSetup(tailnetRequest({ claimUrl: "https://api.test/new", joinCode: "NEW" }))).toBe(true);
    await vi.runAllTimersAsync();
    const legacy = JSON.parse(localStorage.getItem("anywh:profileSetup:redeemedKeys") ?? "[]") as string[];
    expect(legacy).toContain("tailnet:https://api.test/new|NEW");
    const modern = JSON.parse(localStorage.getItem("anywh:profileSetup:keys") ?? "{}") as { spent?: string[] };
    expect(modern.spent).toContain("tailnet:https://api.test/new|NEW");
  });

  it("a typed code is not spent by discovery alone — a failed discovery leaves it enqueueable", async () => {
    discoverPairingEndpointsMock.mockRejectedValueOnce(new Error("no discovery document"));
    const code = "ABCDEF-GHJKMNPQ@example.test";
    enqueueProfileSetup(pairingRequest(code));
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state).toEqual({ status: "failed", mode: "tailnet", stage: "claim" });
    dismissProfileSetup();
    expect(enqueueProfileSetup(pairingRequest(code))).toBe(true);
    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });
});

describe("unverified profiles", () => {
  it("saves the profile as unverified and clears the mark once verification passes", async () => {
    let resolveSessions: ((value: unknown[]) => void) | undefined;
    fetchSessionsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSessions = resolve; }));

    enqueueProfileSetup(directRequest());
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("verifying");
    expect(getProfiles()[0].unverified).toBe(true);

    resolveSessions?.([]);
    await vi.runAllTimersAsync();
    const state = getProfileSetupState().state;
    expect(state?.status).toBe("ready");
    if (state?.status !== "ready") throw new Error("unreachable");
    expect(getProfiles()[0].unverified).toBeUndefined();
    expect(state.profile.unverified).toBeUndefined();
  });

  it("resumeProfileSetup re-enters at connect for a saved profile and never claims", async () => {
    const leftOver = { id: "left", label: "Left", host: "1.2.3.4", relayPort: 8443, unverified: true };
    setProfiles([leftOver]);

    resumeProfileSetup(leftOver);
    await vi.runAllTimersAsync();

    expect(getProfileSetupState().state?.status).toBe("ready");
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();
    expect(getProfiles()[0].unverified).toBeUndefined();
  });

  it("resumeProfileSetup takes the tailnet path for a brokered profile", async () => {
    const leftOver = {
      id: "left-tailnet",
      label: "Left",
      host: "127.0.0.1",
      relayPort: 0,
      tailnetAuthKey: "key",
      tailnetControlUrl: "https://ctrl.test",
      brokerUrl: "https://broker.test/w1",
      brokerNodeId: "node-x",
      unverified: true,
    };
    setProfiles([leftOver]);

    resumeProfileSetup(leftOver);
    await vi.runAllTimersAsync();

    expect(acquireTailnetSidecarMock).toHaveBeenCalledTimes(1);
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("resumeProfileSetup is a no-op while another request is in flight", async () => {
    enqueueProfileSetup(tailnetRequest());
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");

    resumeProfileSetup({ id: "other", label: "Other", host: "9.9.9.9", relayPort: 1, unverified: true });
    await vi.runAllTimersAsync();
    const state = getProfileSetupState().state;
    if (state?.status !== "ready") throw new Error("expected ready");
    expect(state.profile.host).not.toBe("9.9.9.9");
  });
});

describe("hold", () => {
  it("a held queue accepts a link but does not claim it; releasing runs it", async () => {
    const release = holdProfileSetup();
    expect(getProfileSetupState().held).toBe(true);

    expect(enqueueProfileSetup(tailnetRequest())).toBe(true);
    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();
    expect(getProfileSetupState().queuedCount).toBe(1);

    release();
    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetupState().held).toBe(false);
    expect(getProfileSetupState().state?.status).toBe("ready");
  });

  it("holding never interrupts a request already in flight", async () => {
    enqueueProfileSetup(tailnetRequest());
    const release = holdProfileSetup();
    await vi.runAllTimersAsync();
    expect(getProfileSetupState().state?.status).toBe("ready");
    release();
  });

  it("dropping the queue frees the reservations, so the same link is accepted again", async () => {
    const release = holdProfileSetup();
    const request = tailnetRequest({ claimUrl: "https://api.test/drop", joinCode: "DROP" });
    expect(enqueueProfileSetup(request)).toBe(true);
    expect(enqueueProfileSetup(request)).toBe(false);

    dropQueuedProfileSetup();
    expect(getProfileSetupState().queuedCount).toBe(0);
    expect(enqueueProfileSetup(request)).toBe(true);

    release();
    await vi.runAllTimersAsync();
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("releasing twice is harmless", () => {
    const release = holdProfileSetup();
    release();
    release();
    expect(getProfileSetupState().held).toBe(false);
  });
});
