import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

// `vi.hoisted` because these mocks are read by modules this file imports
// statically — the `vi.mock` factories run before the top-level bindings.
const { invokeMock, connectMock, constructedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd: string, _args?: unknown) => {
    if (cmd === "tailnet_sidecar_start") return { addr: "127.0.0.1:12345", nodeKey: "nodekey:abc" };
    return undefined;
  }),
  connectMock: vi.fn(),
  constructedMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));

// The real broker call is signed by the Tauri sidecar and hits the network —
// only its resolved target matters here.
vi.mock("@/lib/profiles/tailnetBroker", () => ({
  fetchConnectGrant: vi.fn(async () => ({ endpoint: { host: "100.64.0.1", port: 8765 }, token: "grant-token" })),
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

    const [host, port, , , token] = constructedMock.mock.calls[0] as [string, number, unknown, unknown, unknown];
    expect({ host, port }).toEqual({ host: "127.0.0.1", port: 12345 });
    expect(typeof token).toBe("function");
    const resolve = token as (options: { wake: boolean }) => Promise<string>;
    await expect(resolve({ wake: true })).resolves.toBe("grant-token");
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
    // The first call hands back the grant the hook already opened with, so
    // it never reaches the broker — the second is the one that does.
    await resolve({ wake: true });
    await resolve({ wake: false });

    expect(vi.mocked(fetchConnectGrant)).toHaveBeenLastCalledWith(tailnetProfile, { wake: false });
  });
});
