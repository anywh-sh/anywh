import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Telemetry is an edge of its own: what the hook counts is recorded here,
// with the once-ever keys honoured the way the real controller does.
const counted = vi.hoisted(() => ({ events: [] as { name: string; props: Record<string, unknown> }[], once: new Set<string>() }));
vi.mock("@/lib/telemetry", () => {
  const record = (name: string, props: Record<string, unknown>) => {
    counted.events.push({ name, props });
    return "sent";
  };
  return {
    telemetry: {
      available: true,
      track: record,
      trackDaily: (_key: string, name: string, props: Record<string, unknown>) => record(name, props),
      trackOnce: (key: string, name: string, props: Record<string, unknown>) => {
        if (counted.once.has(key)) return "dropped";
        counted.once.add(key);
        return record(name, props);
      },
    },
  };
});

import { resetRelayAutoUpdate, useRelayAutoUpdate } from "@/hooks/relay/useRelayAutoUpdate";
import { validateEvent } from "@/lib/telemetry/events";
import type { Profile } from "@/lib/profiles/profiles";

// The relays are the network edge: `fetch` answers as each one would.
interface FakeRelay {
  version: string;
  features: string[];
  updates: unknown[];
  down?: boolean;
  /** What `GET /relay/update` answers. */
  status?: Record<string, unknown>;
  /** What `POST /relay/update` does: by default it takes the request. */
  onUpdate?: (version: string) => Response;
}

let relays: Map<string, FakeRelay>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRelayAutoUpdate();
  counted.events.length = 0;
  counted.once.clear();
  relays = new Map();
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const relay = relays.get(url.port);
    if (!relay || relay.down) return Promise.reject(new TypeError("Failed to fetch"));
    if (url.pathname === "/host-info") {
      return Promise.resolve(new Response(JSON.stringify({ hostname: "h", platform: "linux", editor: null, version: relay.version, features: relay.features })));
    }
    if (url.pathname === "/relay/update" && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { version: string };
      relay.updates.push(body);
      if (relay.onUpdate) return Promise.resolve(relay.onUpdate(body.version));
      return Promise.resolve(new Response(JSON.stringify({ state: "installing", version: "0.2.41" }), { status: 202 }));
    }
    if (url.pathname === "/relay/update" && relay.status) return Promise.resolve(new Response(JSON.stringify(relay.status)));
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

describe("what it counts", () => {
  const fastWatch = { intervalMs: 5, timeoutMs: 60 };
  const named = (name: string) => counted.events.filter((event) => event.name === name).map((event) => event.props);
  const accept = (after: (version: string) => void) => (version: string) => {
    after(version);
    return new Response(JSON.stringify({ state: "installing", version }), { status: 202 });
  };

  it("each relay it reaches: its release against the app's and how it gets updated", async () => {
    relayAt(9001, { version: "0.2.40", features: ["bots", "self_update"] });
    relayAt(9002, { version: "0.2.41", features: [] });
    renderHook(() => useRelayAutoUpdate([profile("a", 9001), { ...profile("b", 9002), host: "127.0.0.1" }], "0.2.41", { watch: fastWatch }));
    await waitFor(() => expect(named("relay_seen")).toHaveLength(2));
    expect(named("relay_seen")).toEqual(
      expect.arrayContaining([
        { relay_version: "0.2.40", vs_app: "older", update_path: "self_update", platform: "linux", profile_kind: "remote", has_bots: true },
        { relay_version: "0.2.41", vs_app: "same", update_path: "installer", platform: "linux", profile_kind: "local", has_bots: false },
      ]),
    );
    // The older one was asked to update; its watch ends before the next test.
    await waitFor(() => expect(named("relay_update_finished")).toEqual([expect.objectContaining({ outcome: "gave_up" })]));
  });

  it("a request taken and the relay back on the new release: requested, then done", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    old.onUpdate = accept((version) => setTimeout(() => (old.version = version), 10));
    renderHook(() => useRelayAutoUpdate([profile("a", 9001)], "0.2.41", { watch: fastWatch }));
    await waitFor(() => expect(named("relay_update_finished")).toHaveLength(1));
    expect(named("relay_update_requested")).toEqual([{ from_version: "0.2.40", to_version: "0.2.41", result: "accepted" }]);
    expect(named("relay_update_finished")[0]).toMatchObject({ path: "auto", outcome: "done", from_version: "0.2.40", to_version: "0.2.41" });
    for (const { name, props } of counted.events) expect(validateEvent(name, props), `${name} ${JSON.stringify(props)}`).not.toBeNull();
  });

  it("an install that fails is counted by the installer's code and step, and not as an error shown: nothing shows it", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    old.onUpdate = accept((version) => (old.status = { state: "failed", version, code: "preflight_failed", step: "preflight", message: "GLIBC_2.42 not found in /home/x" }));
    renderHook(() => useRelayAutoUpdate([profile("a", 9001)], "0.2.41", { watch: fastWatch }));
    await waitFor(() => expect(named("relay_update_finished")).toHaveLength(1));
    expect(named("relay_update_finished")[0]).toMatchObject({ outcome: "failed", reason: "installer", installer_code: "preflight_failed", installer_step: "preflight" });
    expect(named("error_shown")).toEqual([]);
    expect(JSON.stringify(counted.events)).not.toContain("GLIBC");
  });

  it("an install still waiting on the conversations when the watch ends says so", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    old.onUpdate = accept((version) => (old.status = { state: "installed", version }));
    renderHook(() => useRelayAutoUpdate([profile("a", 9001)], "0.2.41", { watch: fastWatch }));
    await waitFor(() => expect(named("relay_update_finished")).toHaveLength(1));
    expect(named("relay_update_finished")[0]).toMatchObject({ outcome: "gave_up", last_state: "installed" });
  });

  it("an app left open looks again for a relay not yet counted today", async () => {
    relayAt(9001, { version: "0.2.41", features: [] });
    renderHook(() => useRelayAutoUpdate([profile("a", 9001)], "0.2.41", { watch: fastWatch, seenRecheckMs: 20 }));
    // The fake controller never marks the day as done, so each pass counts again.
    await waitFor(() => expect(named("relay_seen").length).toBeGreaterThanOrEqual(2));
  });

  it("stops following an update once the profile is gone, and reports nothing for it", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"] });
    old.onUpdate = accept((version) => (old.status = { state: "installing", version }));
    const { rerender } = renderHook(({ list }) => useRelayAutoUpdate(list, "0.2.41", { watch: { intervalMs: 20, timeoutMs: 200 } }), { initialProps: { list: [profile("a", 9001)] } });
    await waitFor(() => expect(named("relay_update_requested")).toHaveLength(1));
    rerender({ list: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(named("relay_update_finished")).toEqual([]);
  });

  it("a failure the relay still holds from before is counted once, before asking again", async () => {
    const old = relayAt(9001, { version: "0.2.40", features: ["self_update"], status: { state: "failed", version: "0.2.41", code: "download_failed", step: "download", message: "x" } });
    old.onUpdate = () => new Response(JSON.stringify({ error: "busy" }), { status: 409 });
    const { rerender } = renderHook(({ list }) => useRelayAutoUpdate(list, "0.2.41", { watch: fastWatch }), { initialProps: { list: [profile("a", 9001)] } });
    await waitFor(() => expect(named("relay_update_requested")).toHaveLength(1));
    // The refused request leaves the relay to be asked again; the failure it
    // still holds is the same one.
    rerender({ list: [profile("a", 9001), profile("b", 9002)] });
    await waitFor(() => expect(named("relay_update_requested")).toHaveLength(2));
    expect(named("relay_update_finished")).toEqual([expect.objectContaining({ outcome: "failed", installer_code: "download_failed" })]);
    expect(named("relay_update_requested")[0]).toMatchObject({ result: "busy" });
  });
});
