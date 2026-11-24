import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

// The real RelayClient and the real sidecar registry; only the edges are
// faked: the Tauri command that starts the sidecar, the signed broker call,
// and the socket.
const { invokeMock, fetchConnectGrantMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((cmd: string, _args?: unknown): Promise<unknown> => {
    if (cmd === "tailnet_sidecar_start") return Promise.resolve({ addr: "127.0.0.1:12345", nodeKey: "nodekey:abc" });
    return Promise.resolve(undefined);
  }),
  fetchConnectGrantMock: vi.fn(() => Promise.resolve({ endpoint: { host: "100.64.0.1", port: 8765 }, token: "grant-token" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));
vi.mock("@/lib/profiles/tailnetBroker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/tailnetBroker")>()),
  fetchConnectGrant: fetchConnectGrantMock,
  reportTailnetKey: () => Promise.resolve(),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = 0;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

import { useRelayClient } from "@/hooks/relay/useRelayClient";

const tailnetProfile: Profile = {
  id: "retry-at-launch",
  label: "Sandbox",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  brokerUrl: "https://api.test/v1/connect/w1",
  brokerNodeId: "node-1",
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  invokeMock.mockClear();
  fetchConnectGrantMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRelayClient tailnet acquisition retry", () => {
  it("connects after a first grant that rejects, with no app restart", async () => {
    // ENG-99: the launch grant is refused (seen live as a 401 `replayed`,
    // and a `stale_timestamp` during a control-plane deploy). That used to
    // leave the tab dead until the app quit.
    fetchConnectGrantMock.mockImplementationOnce(() => Promise.reject(new Error("broker refused the connection request (401)")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useRelayClient(tailnetProfile, "session-1"));
    await act(() => vi.runOnlyPendingTimersAsync()); // deferred start, first attempt fails
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(() => vi.runOnlyPendingTimersAsync()); // RelayClient's backoff retries
    expect(fetchConnectGrantMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(new URL(socket.url).host).toBe("127.0.0.1:12345");

    act(() => {
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit("open");
    });
    expect(result.current.connected).toBe(true);
  });

  it("starts the sidecar again when its first join failed", async () => {
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("tsnet up: control plane unavailable")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useRelayClient({ ...tailnetProfile, id: "retry-join" }, "session-2"));
    await act(() => vi.runOnlyPendingTimersAsync());
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "tailnet_sidecar_start")).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      FakeWebSocket.instances[0].readyState = FakeWebSocket.OPEN;
      FakeWebSocket.instances[0].emit("open");
    });
    expect(result.current.connected).toBe(true);
  });
});
