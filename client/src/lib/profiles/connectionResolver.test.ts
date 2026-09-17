import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { peekMock, acquireMock, releaseMock, fetchConnectGrantMock, resolveTailnetTargetMock } = vi.hoisted(() => ({
  peekMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  fetchConnectGrantMock: vi.fn(),
  resolveTailnetTargetMock: vi.fn(),
}));
vi.mock("@/lib/profiles/tailnetSidecar", () => ({
  peekTailnetSidecar: peekMock,
  acquireTailnetSidecar: acquireMock,
  releaseTailnetSidecar: releaseMock,
}));
vi.mock("@/lib/profiles/tailnetBroker", () => ({
  fetchConnectGrant: fetchConnectGrantMock,
  resolveTailnetTarget: resolveTailnetTargetMock,
}));

import { resolveConnection, authHeaders } from "@/lib/profiles/connectionResolver";

const directProfile: Profile = {
  id: "direct",
  label: "Direct",
  host: "192.168.0.10",
  relayPort: 8765,
  connectToken: "static-token",
};

const brokeredProfile: Profile = {
  id: "brokered",
  label: "Sandbox",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  brokerUrl: "https://api.test/v1/connect/w1",
  brokerNodeId: "node-1",
};

beforeEach(() => {
  peekMock.mockReset();
  acquireMock.mockReset();
  releaseMock.mockReset();
  fetchConnectGrantMock.mockReset();
  resolveTailnetTargetMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConnection", () => {
  it("resolves a direct profile synchronously from its own fields, touching no tailnet machinery", async () => {
    const resolved = await resolveConnection(directProfile);
    expect(resolved).toEqual({ host: "192.168.0.10", port: 8765, token: "static-token" });
    expect(peekMock).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("peeks an already-running sidecar and fetches a fresh grant for the token, without acquiring", async () => {
    peekMock.mockReturnValue(Promise.resolve({ host: "127.0.0.1", port: 54321 }));
    fetchConnectGrantMock.mockResolvedValue({ endpoint: { host: "100.64.0.1", port: 8443 }, token: "fresh-token" });

    const resolved = await resolveConnection(brokeredProfile);

    expect(resolved).toEqual({ host: "127.0.0.1", port: 54321, token: "fresh-token" });
    expect(peekMock).toHaveBeenCalledWith("brokered");
    expect(acquireMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("acquires-and-releases just for this call when nobody already owns the sidecar", async () => {
    peekMock.mockReturnValue(undefined);
    resolveTailnetTargetMock.mockResolvedValue({ target: "100.64.0.1:8443", token: "cold-token" });
    acquireMock.mockResolvedValue({ host: "127.0.0.1", port: 9999 });

    const resolved = await resolveConnection(brokeredProfile);

    expect(resolved).toEqual({ host: "127.0.0.1", port: 9999, token: "cold-token" });
    expect(acquireMock).toHaveBeenCalledWith(brokeredProfile, "100.64.0.1:8443");
    expect(releaseMock).toHaveBeenCalledWith("brokered");
    // Only one grant resolved (inside `resolveTailnetTarget`) — the same one
    // supplies both the target used to acquire and the token returned,
    // instead of two round-trips.
    expect(fetchConnectGrantMock).not.toHaveBeenCalled();
  });

  it("releases the one-off acquisition even when the join itself fails", async () => {
    peekMock.mockReturnValue(undefined);
    resolveTailnetTargetMock.mockResolvedValue({ target: "100.64.0.1:8443", token: "cold-token" });
    acquireMock.mockRejectedValue(new Error("join failed"));

    await expect(resolveConnection(brokeredProfile)).rejects.toThrow("join failed");
    expect(releaseMock).toHaveBeenCalledWith("brokered");
  });
});

describe("authHeaders", () => {
  it("carries a Bearer header when a token is given", () => {
    expect(authHeaders("abc")).toEqual({ Authorization: "Bearer abc" });
  });

  it("is empty for a direct profile with no token at all", () => {
    expect(authHeaders(undefined)).toEqual({});
  });
});
