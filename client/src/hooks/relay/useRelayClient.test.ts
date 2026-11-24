import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

// `vi.hoisted` because these mocks are read by modules this file imports
// statically — the `vi.mock` factories run before the top-level bindings.
const { invokeMock, connectMock, constructedMock, setPresenceMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === "tailnet_sidecar_start") return { addr: "127.0.0.1:12345", nodeKey: "nodekey:abc" };
    return undefined;
  }),
  connectMock: vi.fn(),
  constructedMock: vi.fn(),
  setPresenceMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));

// The real broker call is signed by the Tauri sidecar and hits the network —
// only its resolved target matters here.
vi.mock("@/lib/profiles/tailnetBroker", () => ({
  fetchConnectGrant: vi.fn(async () => ({ endpoint: { host: "100.64.0.1", port: 8765 }, token: "grant-token" })),
  grantTarget: (grant: { endpoint: { host: string; port: number } }) => `${grant.endpoint.host}:${String(grant.endpoint.port)}`,
  BrokerRevokedError: class extends Error {},
  // tailnetSidecar.ts's own cold-start report call — not what this file is
  // about (covered by tailnetSidecar.test.ts/tailnetBroker.test.ts).
  reportTailnetKey: vi.fn(async () => {}),
}));

// A real RelayClient would open a WebSocket; the connection itself is not
// what this file is about.
vi.mock("@/lib/relay/relayClient", () => ({
  RelayClient: class {
    connect = connectMock;
    disconnect = vi.fn();
    setPresence = setPresenceMock;
    constructor(...args: unknown[]) {
      constructedMock(...args);
    }
  },
}));

import { fetchConnectGrant } from "@/lib/profiles/tailnetBroker";
import { useRelayClient } from "@/hooks/relay/useRelayClient";

// A brokered tailnet profile — `host`/`relayPort` are the placeholder
// profileImport.ts writes, never dialed directly (see useRelayClient).
const tailnetProfile: Profile = {
  id: "tailnet-profile",
  label: "Tailnet",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  brokerUrl: "https://api.test/v1/connect/w1",
  brokerNodeId: "node-1",
};

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
  connectMock.mockClear();
  constructedMock.mockClear();
  setPresenceMock.mockClear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("useRelayClient tailnet mode", () => {
  it("does not stop a sidecar another tab is still using when a tab unmounts before acquiring it", async () => {
    // Tab A: mounted and settled, so it holds the only reference to the
    // profile's sidecar.
    const tabA = renderHook(() => useRelayClient(tailnetProfile, "session-a"));
    await vi.runAllTimersAsync();
    // The client's first connection attempt is what joins the sidecar.
    const [, , , , resolveA] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, (o: { wake: boolean }) => Promise<unknown>];
    await resolveA({ wake: true });
    expect(invokeMock).toHaveBeenCalledWith("tailnet_sidecar_start", expect.anything());

    // Tab B: opened and closed again before its own deferred `start()` ever
    // ran, so it never acquired the sidecar in the first place — its cleanup
    // must not release a reference it doesn't hold.
    const tabB = renderHook(() => useRelayClient(tailnetProfile, "session-b"));
    tabB.unmount();
    await vi.runAllTimersAsync();

    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());

    tabA.unmount();
    await vi.runAllTimersAsync();
  });

  it("hands the relay client a token resolver, not the single grant it opened with", async () => {
    // The broker's token authorizes one handshake, so the
    // client has to be able to ask for another one — see relayClient.test.ts
    // for what it does with this.
    renderHook(() => useRelayClient(tailnetProfile, "session-a"));
    await vi.runAllTimersAsync();

    const [, , , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    expect(typeof token).toBe("function");
    const resolve = token as (options: { wake: boolean }) => Promise<unknown>;
    // The placeholder host/port the client was built with are never dialed:
    // each attempt says where the sidecar listens.
    await expect(resolve({ wake: true })).resolves.toEqual({ token: "grant-token", host: "127.0.0.1", port: 12345 });
  });

  it("passes the caller's wake intent straight through to the broker call", async () => {
    // RelayClient decides this, not the hook: false for a reconnect its own
    // timer scheduled, true for one the user caused. Forwarding it is the
    // whole point — a background reconnect that still woke the machine is
    // the loop this exists to break.
    renderHook(() => useRelayClient(tailnetProfile, "session-a"));
    await vi.runAllTimersAsync();

    const [, , , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    const resolve = token as (options: { wake: boolean }) => Promise<string>;
    await resolve({ wake: true });
    expect(vi.mocked(fetchConnectGrant)).toHaveBeenLastCalledWith(tailnetProfile, { wake: true });
    await resolve({ wake: false });

    expect(vi.mocked(fetchConnectGrant)).toHaveBeenLastCalledWith(tailnetProfile, { wake: false });
  });

  it("restarts the sidecar at a new endpoint a reconnect grant names, and dials the restarted one", async () => {
    // ENG-98: the sandbox was recreated under an open app, so it joined the
    // tailnet as a new node. The sidecar started from the first grant dials
    // the old address; the reconnect's grant is the only news of the new one.
    renderHook(() => useRelayClient(tailnetProfile, "session-a"));
    await vi.runAllTimersAsync();

    const [, , , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    const resolve = token as (options: { wake: boolean }) => Promise<unknown>;
    await resolve({ wake: true }); // joins the sidecar at the first endpoint

    vi.mocked(fetchConnectGrant).mockResolvedValueOnce({ endpoint: { host: "100.64.0.3", port: 8765 }, token: "moved-token" });
    invokeMock.mockImplementationOnce(() => Promise.resolve({ addr: "127.0.0.1:23456", nodeKey: "nodekey:moved" }));
    const resolved = await resolve({ wake: false });

    expect(invokeMock).toHaveBeenLastCalledWith("tailnet_sidecar_start", expect.objectContaining({ target: "100.64.0.3:8765" }));
    expect(resolved).toEqual({ token: "moved-token", host: "127.0.0.1", port: 23456 });
    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());
  });

  it("retries a sidecar join that failed on the next attempt, instead of caching the failure", async () => {
    // ENG-99: the first join fails (a 401 at launch, a control plane
    // mid-deploy). That attempt fails like any other, and the next one
    // RelayClient schedules starts the sidecar again.
    renderHook(() => useRelayClient({ ...tailnetProfile, id: "retry-profile" }, "session-retry"));
    await vi.runAllTimersAsync();
    const [, , , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    const resolve = token as (options: { wake: boolean }) => Promise<unknown>;

    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("tsnet up: 401")));
    await expect(resolve({ wake: true })).rejects.toThrow("401");

    await expect(resolve({ wake: false })).resolves.toEqual({ token: "grant-token", host: "127.0.0.1", port: 12345 });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "tailnet_sidecar_start")).toHaveLength(2);
    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());
  });

  it("keeps the running sidecar when a reconnect grant names the same endpoint", async () => {
    renderHook(() => useRelayClient(tailnetProfile, "session-a"));
    await vi.runAllTimersAsync();
    const [, , , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    const resolve = token as (options: { wake: boolean }) => Promise<unknown>;
    await resolve({ wake: true });
    invokeMock.mockClear();

    const resolved = await resolve({ wake: false });

    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_start", expect.anything());
    expect(resolved).toEqual({ token: "grant-token", host: "127.0.0.1", port: 12345 });
  });
});

describe("useRelayClient presence", () => {
  it("hands a claim made before the client existed to the client once it is created, and forwards later ones", async () => {
    const { result } = renderHook(() => useRelayClient(tailnetProfile, "session-presence"));
    act(() => result.current.setPresence(true));
    expect(setPresenceMock).not.toHaveBeenCalled(); // no client yet, nothing to tell

    await vi.runAllTimersAsync();
    expect(constructedMock).toHaveBeenCalled();
    expect(setPresenceMock).toHaveBeenCalledWith(true);

    setPresenceMock.mockClear();
    act(() => result.current.setPresence(false));
    expect(setPresenceMock).toHaveBeenCalledWith(false);
  });
});
