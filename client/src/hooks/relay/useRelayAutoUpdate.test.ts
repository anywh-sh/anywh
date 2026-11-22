import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRelayAutoUpdate, useRelayAutoUpdate } from "@/hooks/relay/useRelayAutoUpdate";
import type { Profile } from "@/lib/profiles/profiles";

// The relays are the network edge: `fetch` answers as each one would.
interface FakeRelay {
  version: string;
  features: string[];
  updates: unknown[];
  down?: boolean;
}

let relays: Map<string, FakeRelay>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRelayAutoUpdate();
  relays = new Map();
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const relay = relays.get(url.port);
    if (!relay || relay.down) return Promise.reject(new TypeError("Failed to fetch"));
    if (url.pathname === "/host-info") {
      return Promise.resolve(new Response(JSON.stringify({ hostname: "h", platform: "linux", editor: null, version: relay.version, features: relay.features })));
    }
    if (url.pathname === "/relay/update" && init?.method === "POST") {
      relay.updates.push(JSON.parse(init.body as string));
      return Promise.resolve(new Response(JSON.stringify({ state: "installing", version: "0.2.41" }), { status: 202 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function profile(id: string, port: number): Profile {
  return { id, label: id, host: "100.64.0.5", relayPort: port };
}

function relayAt(port: number, relay: Omit<FakeRelay, "updates">): FakeRelay {
  const entry = { ...relay, updates: [] };
  relays.set(String(port), entry);
  return entry;
}

function hostInfoCalls(port: number): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(`:${port}/host-info`)).length;
}

describe("useRelayAutoUpdate", () => {
  it("asks every older relay that can update itself to install the app's version, and only those", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["bots", "self_update"] });
    const current = relayAt(9002, { version: "0.2.41", features: ["bots", "self_update"] });
    const tooOld = relayAt(9003, { version: "0.2.30", features: ["bots"] });
    renderHook(() => useRelayAutoUpdate([profile("a", 9001), profile("b", 9002), profile("c", 9003)], "0.2.41"));

    await waitFor(() => expect(old.updates).toEqual([{ version: "0.2.41" }]));
    await waitFor(() => expect(hostInfoCalls(9002) + hostInfoCalls(9003)).toBe(2));
    expect(current.updates).toEqual([]);
    expect(tooOld.updates).toEqual([]);
  });

  it("asks each relay once per launch, however often the profiles re-render", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    const { rerender } = renderHook(({ list }) => useRelayAutoUpdate(list, "0.2.41"), { initialProps: { list: [profile("a", 9001)] } });
    await waitFor(() => expect(old.updates).toHaveLength(1));
    rerender({ list: [{ ...profile("a", 9001), label: "renamed" }] });
    rerender({ list: [profile("a", 9001), profile("b", 9002)] });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes(":9002/"))).toBe(true));
    expect(old.updates).toHaveLength(1);
    expect(hostInfoCalls(9001)).toBe(1);
  });

  it("a relay that could not be reached is asked again the next time the profiles change", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"], down: true });
    const { rerender } = renderHook(({ list }) => useRelayAutoUpdate(list, "0.2.41"), { initialProps: { list: [profile("a", 9001)] } });
    await waitFor(() => expect(hostInfoCalls(9001)).toBe(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    old.down = false;
    rerender({ list: [profile("a", 9001), profile("b", 9002)] });
    await waitFor(() => expect(old.updates).toEqual([{ version: "0.2.41" }]));
  });

  it("a build from source asks no relay to update", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    renderHook(() => useRelayAutoUpdate([profile("a", 9001)], "0.0.0"));
    await waitFor(() => expect(hostInfoCalls(9001)).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(old.updates).toEqual([]);
  });
});
