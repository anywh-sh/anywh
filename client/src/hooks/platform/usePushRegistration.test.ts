import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPushAddressProvider, type PushAddress, type PushAddressProvider } from "@/lib/platform/pushAddress";
import { hasRegistration, isPushActive, resetPushRegistrationForTests } from "@/lib/platform/pushRegistration";
import { addProfile, removeProfile, type Profile } from "@/lib/profiles/profiles";
import { usePushRegistration } from "./usePushRegistration";

const a: Profile = { id: "pessoal", label: "Pessoal", host: "100.64.0.9", relayPort: 8765 };
const b: Profile = { id: "trabalho", label: "Trabalho", host: "100.64.0.9", relayPort: 8766 };
const address: PushAddress = { gatewayUrl: "https://gw.example.test/n", pushKey: "key-1" };

/** A provider whose address the test can change, the way the private layer's would. */
function controllableProvider(initial: PushAddress | null) {
  let listener: ((a: PushAddress | null) => void) | null = null;
  const provider: PushAddressProvider = {
    getAddress: () => Promise.resolve(initial),
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return { provider, emit: (next: PushAddress | null) => listener?.(next) };
}

const fetchMock = vi.fn();
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === method).map(([url]) => url as string);

beforeEach(() => {
  localStorage.clear();
  resetPushRegistrationForTests();
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  setPushAddressProvider(null);
  vi.unstubAllGlobals();
});

describe("usePushRegistration", () => {
  it("does nothing at all without a provider", async () => {
    renderHook(() => usePushRegistration([a, b]));
    await act(() => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers on every profile once the provider hands over an address, including one installed after mount", async () => {
    renderHook(() => usePushRegistration([a, b]));
    await act(() => {
      setPushAddressProvider(controllableProvider(address).provider);
      return Promise.resolve();
    });

    await waitFor(() => expect(calls("PUT")).toHaveLength(2));
    expect(calls("PUT").some((u) => u.startsWith("http://100.64.0.9:8765/"))).toBe(true);
    expect(calls("PUT").some((u) => u.startsWith("http://100.64.0.9:8766/"))).toBe(true);
    expect(isPushActive("pessoal") && isPushActive("trabalho")).toBe(true);
  });

  it("registers a profile added later, and re-registers everywhere when the address rotates", async () => {
    const { provider, emit } = controllableProvider(address);
    setPushAddressProvider(provider);
    const { rerender } = renderHook(({ profiles }) => usePushRegistration(profiles), { initialProps: { profiles: [a] } });
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));

    rerender({ profiles: [a, b] });
    await waitFor(() => expect(calls("PUT")).toHaveLength(2));

    await act(() => {
      emit({ ...address, pushKey: "key-2" });
      return Promise.resolve();
    });
    await waitFor(() => expect(calls("PUT")).toHaveLength(4));
  });

  it("takes the address off every relay when it goes away", async () => {
    const { provider, emit } = controllableProvider(address);
    setPushAddressProvider(provider);
    renderHook(() => usePushRegistration([a, b]));
    await waitFor(() => expect(calls("PUT")).toHaveLength(2));

    await act(() => {
      emit(null);
      return Promise.resolve();
    });
    await waitFor(() => expect(calls("DELETE")).toHaveLength(2));
    expect(isPushActive("pessoal")).toBe(false);
    expect(hasRegistration("trabalho")).toBe(false);
  });

  it("an address that isn't a well-formed one counts as none", async () => {
    const { provider, emit } = controllableProvider(null);
    setPushAddressProvider(provider);
    renderHook(() => usePushRegistration([a]));
    await act(() => {
      emit({ gatewayUrl: "", pushKey: "x" });
      return Promise.resolve();
    });
    await act(() => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removing a registered profile takes the address off its relay before it is gone", async () => {
    setPushAddressProvider(controllableProvider(address).provider);
    addProfile(a);
    renderHook(() => usePushRegistration([a]));
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));

    act(() => {
      removeProfile("pessoal");
    });
    await waitFor(() => expect(calls("DELETE")).toEqual([expect.stringContaining("http://100.64.0.9:8765/push/devices/")]));
  });

  it("removing a profile that never registered sends nothing", async () => {
    addProfile(a);
    renderHook(() => usePushRegistration([a]));
    act(() => {
      removeProfile("pessoal");
    });
    await act(() => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
