import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles";
import type { SessionSummary } from "@/lib/relay-types";
import { BrokerAsleepError, BrokerRevokedError } from "@/lib/tailnetBroker";
import { getCachedSessions } from "@/lib/sessionListCache";

const { fetchSessionsMock, resolveConnectionMock } = vi.hoisted(() => ({
  fetchSessionsMock: vi.fn(async (): Promise<SessionSummary[]> => []),
  resolveConnectionMock: vi.fn(),
}));
vi.mock("@/lib/relayClient", () => ({ fetchSessions: fetchSessionsMock }));
vi.mock("@/lib/connectionResolver", () => ({ resolveConnection: resolveConnectionMock }));

/** Minimal stand-in for the browser `WebSocket`, same shape as
 * relayClient.test.ts's own fixture. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.emit("close");
  }
}

import { useSessionNames } from "@/hooks/useSessionNames";

const tailnetProfile: Profile = {
  id: "sandbox-a",
  label: "Sandbox A",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  fetchSessionsMock.mockClear().mockResolvedValue([]);
  resolveConnectionMock.mockReset();
  let call = 0;
  resolveConnectionMock.mockImplementation(async () => {
    call += 1;
    return { host: "127.0.0.1", port: 54321, token: `grant-token-${String(call)}` };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSessionNames", () => {
  it("fetches the session list through the resolved connection, token included", async () => {
    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });
    expect(fetchSessionsMock).toHaveBeenCalledWith("127.0.0.1", 54321, "grant-token-1");
  });

  it("opens the sessions/watch socket with the resolved token as a query param", async () => {
    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:54321/sessions/watch?token=grant-token-2");
  });

  it("resolves a fresh grant (not the first connection's) when the watch socket reconnects", async () => {
    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket.url).toContain("grant-token-2");

    await act(async () => {
      firstSocket.close();
      await vi.advanceTimersByTimeAsync(2000);
    });

    const secondSocket = FakeWebSocket.instances[1];
    // A brand-new connection needs its own unspent token —
    // reusing the first one would be rejected as a replay by the proxy.
    expect(secondSocket.url).not.toBe(firstSocket.url);
    expect(secondSocket.url).toContain("grant-token-3");
  });

  it("asks to wake on mount, and never on the reconnect its own socket closing caused", async () => {
    // The loop this closes: the sandbox suspends because nobody was using
    // it, that kills the watch socket, and the reconnect two seconds later
    // resumes the very sandbox the idle timeout just put to sleep — once per
    // idle cycle, for as long as the window stays open.
    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });
    expect(resolveConnectionMock).toHaveBeenCalledWith(tailnetProfile, { wake: true });

    await act(async () => {
      FakeWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(resolveConnectionMock).toHaveBeenLastCalledWith(tailnetProfile, { wake: false });
  });

  it("slows the watch retry to a minute when the broker says the machine is asleep", async () => {
    resolveConnectionMock.mockReset().mockRejectedValue(new BrokerAsleepError());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });
    const afterFirst = resolveConnectionMock.mock.calls.length;

    // The old 2s pace would have fired several times in this window. It
    // still retries eventually — cheap, since a wake:false call never
    // resumes anything — so the sidebar reattaches on its own once
    // something else brings the machine up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(resolveConnectionMock.mock.calls.length).toBe(afterFirst);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(resolveConnectionMock.mock.calls.length).toBeGreaterThan(afterFirst);
    consoleErrorSpy.mockRestore();
  });

  it("stops retrying the sessions/watch socket once the device's connection was permanently revoked", async () => {
    resolveConnectionMock.mockReset();
    resolveConnectionMock.mockRejectedValue(new BrokerRevokedError());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    const callsAfterInitialFailure = resolveConnectionMock.mock.calls.length;

    // A generous window well past the fixed 2s retry this socket otherwise
    // uses — if a reconnect were still scheduled, this would fire several.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(resolveConnectionMock.mock.calls.length).toBe(callsAfterInitialFailure);
    consoleErrorSpy.mockRestore();
  });

  it("writes the fetched list into the shared cache under the profile's own id", async () => {
    const fromA = { id: "s1", title: "From A", lastActiveAt: 1_700_000_000_000 };
    fetchSessionsMock.mockResolvedValueOnce([fromA]);

    await act(async () => {
      renderHook(() => useSessionNames(tailnetProfile));
      await vi.runAllTimersAsync();
    });

    // The hook holds no list of its own any more: the sidebar shows every
    // profile at once, so the rows have to land somewhere shared.
    expect(getCachedSessions(tailnetProfile.id).sessions).toEqual([fromA]);
    expect(getCachedSessions(tailnetProfile.id).syncedAt).not.toBeNull();
  });

  it("switching profile A -> B reports B's sync state, and keeps A's rows cached", async () => {
    const fromA = { id: "s1", title: "From A", lastActiveAt: 1_700_000_000_000 };
    fetchSessionsMock.mockResolvedValueOnce([fromA]);
    const profileB: Profile = { ...tailnetProfile, id: "sandbox-b" };

    const { result, rerender } = renderHook(({ profile }) => useSessionNames(profile), {
      initialProps: { profile: tailnetProfile },
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.loading).toBe(false);

    fetchSessionsMock.mockResolvedValueOnce([]);
    rerender({ profile: profileB });
    // The render right after the switch already describes B, not a frame
    // still claiming A's finished sync.
    expect(result.current.loading).toBe(true);
    // And A's rows survive it — that is the entire point of the shared
    // cache: switching profile no longer throws a list away.
    expect(getCachedSessions(tailnetProfile.id).sessions).toEqual([fromA]);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
  });

  it("keeps a late response for a profile that was switched away from", async () => {
    // The response is a real, fresh list for that profile; discarding it
    // because the user moved on would leave those rows staler than they
    // need to be, for no benefit.
    let resolveA: (value: SessionSummary[]) => void = () => {};
    fetchSessionsMock.mockImplementationOnce(
      () =>
        new Promise<SessionSummary[]>((resolve) => {
          resolveA = resolve;
        }),
    );
    const profileB: Profile = { ...tailnetProfile, id: "sandbox-b" };

    const { rerender } = renderHook(({ profile }) => useSessionNames(profile), {
      initialProps: { profile: tailnetProfile },
    });
    rerender({ profile: profileB });
    // Lets A's `resolveConnection` settle so its `fetchSessions` actually
    // runs — until it does, nothing is in flight to arrive late.
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const late = [{ id: "late", title: "Arrived after the switch", lastActiveAt: 5 }];
    await act(async () => {
      resolveA(late);
      await vi.runAllTimersAsync();
    });

    expect(getCachedSessions(tailnetProfile.id).sessions).toEqual(late);
  });

  it("sets error when the one-shot fetch rejects", async () => {
    resolveConnectionMock.mockRejectedValueOnce(new Error("network down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useSessionNames(tailnetProfile));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it("reload() clears the error, shows the skeleton again, and refetches", async () => {
    resolveConnectionMock.mockRejectedValueOnce(new Error("network down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useSessionNames(tailnetProfile));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.error).toBe(true);

    act(() => {
      result.current.reload();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(false);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.error).toBe(false);
    expect(result.current.loading).toBe(false);
    consoleErrorSpy.mockRestore();
  });
});
