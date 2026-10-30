import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAN_USAGE_CLOCK_MS, usePlanUsage } from "@/hooks/relay/usePlanUsage";
import type { RuntimePlanUsage } from "@/lib/planUsage/model";
import { PING_INTERVAL_MS, PONG_TIMEOUT_MS, REFRESH_TIMEOUT_MS } from "@/lib/planUsage/watch";
import { resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import { BrokerAsleepError, BrokerRevokedError } from "@/lib/profiles/tailnetBroker";
import { installFakeRelay, type FakeRelay } from "../../../tests/ui/helpers/fakeRelay";

// The real resolver, recorded: a direct profile resolves from its own fields,
// so the only thing the spy adds is a view of the `wake` each dial asked for
// — the one part of a brokered connection this hook decides.
vi.mock("@/lib/profiles/connectionResolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles/connectionResolver")>();
  return { ...actual, resolveConnection: vi.fn(actual.resolveConnection) };
});
const resolveSpy = vi.mocked(resolveConnection);

const PESSOAL: Profile = { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8001 };
const TRABALHO: Profile = { id: "trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: 8002 };

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function claude(usedPercent: number): RuntimePlanUsage {
  return {
    runtime: "claude",
    status: "ok",
    windows: [{ durationMins: 300, usedPercent, resetsAt: NOW + 3_600_000 }],
    observedAt: NOW,
    accountKey: "0123456789abcdef",
  };
}

let relay: FakeRelay;

/** Lets every pending dial, socket open and message land. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const wakesFor = (profileId: string): (boolean | undefined)[] =>
  resolveSpy.mock.calls.filter(([profile]) => profile.id === profileId).map(([, options]) => options?.wake);

const planSockets = () => relay.sockets.filter((socket) => socket.url.includes("/plan-usage/watch"));
const refreshes = () => relay.sent.filter((entry) => entry.message.type === "plan_usage_refresh");
const pings = () => relay.sent.filter((entry) => entry.message.type === "ping");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  // Back to the recorded real resolver (a test may have scripted it).
  resolveSpy.mockReset();
});

afterEach(() => {
  relay.uninstall();
  vi.useRealTimers();
});

describe("usePlanUsage", () => {
  it("opens one socket per profile and keeps each relay's state", async () => {
    relay = installFakeRelay(undefined, {
      planUsage: { "127.0.0.1:8001": { runtimes: [claude(58)], observedAt: NOW - 5_000 }, "127.0.0.1:8002": { runtimes: [claude(82)] } },
    });
    const { result } = renderHook(() => usePlanUsage([PESSOAL, TRABALHO], "pessoal"));
    expect(result.current.byProfile.pessoal.connection).toBe("connecting");
    await settle();

    expect(planSockets().map((socket) => socket.url)).toEqual([
      "ws://127.0.0.1:8001/plan-usage/watch",
      "ws://127.0.0.1:8002/plan-usage/watch",
    ]);
    expect(result.current.byProfile.pessoal).toMatchObject({ connection: "live", observedAt: NOW - 5_000, receivedAt: NOW });
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(58);
    expect(result.current.byProfile.trabalho.runtimes?.[0].windows[0].usedPercent).toBe(82);
  });

  it("follows pushes from the relay", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    act(() => relay.emitPlanUsage("127.0.0.1:8001", [claude(64)]));
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(64);
  });

  it("lets only the active profile wake its machine", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [] }, "127.0.0.1:8002": { runtimes: [] } } });
    renderHook(() => usePlanUsage([PESSOAL, TRABALHO], "trabalho"));
    await settle();
    expect(wakesFor("trabalho")).toEqual([true]);
    expect(wakesFor("pessoal")).toEqual([false]);
  });

  it("reconnects a dropped socket without waking, keeping the last numbers as stale", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(40)] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();

    relay.planUsage!["127.0.0.1:8001"] = "unreachable";
    act(() => planSockets()[0].close());
    expect(result.current.byProfile.pessoal.connection).toBe("offline");
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(40);

    await settle(2_000);
    expect(wakesFor("pessoal")).toEqual([true, false]);
    // Backs off while the machine stays unreachable: next try 4s later.
    await settle(3_999);
    expect(planSockets()).toHaveLength(2);
    await settle(1);
    expect(planSockets()).toHaveLength(3);

    relay.planUsage!["127.0.0.1:8001"] = { runtimes: [claude(45)] };
    await settle(8_000);
    expect(result.current.byProfile.pessoal).toMatchObject({ connection: "live" });
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(45);
  });

  it("gives up on a relay that predates the route, without a reconnect loop", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": "legacy" } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    expect(result.current.byProfile.pessoal).toMatchObject({ connection: "unsupported", runtimes: null });
    expect(planSockets()[0].readyState).toBe(3);

    await settle(10 * 60_000);
    expect(planSockets()).toHaveLength(1);
    // Not even when the window comes back to the foreground.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(planSockets()).toHaveLength(1);
  });

  it("stops for good on a revoked device", async () => {
    relay = installFakeRelay(undefined, { planUsage: {} });
    resolveSpy.mockRejectedValueOnce(new BrokerRevokedError());
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle(10 * 60_000);
    expect(result.current.byProfile.pessoal.connection).toBe("revoked");
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("waits a full minute on a sleeping machine, then wakes it when its tab becomes active", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [] }, "127.0.0.1:8002": { runtimes: [claude(5)] } } });
    resolveSpy.mockImplementation((profile, options) =>
      profile.id === "trabalho" && options?.wake === false
        ? Promise.reject(new BrokerAsleepError())
        : Promise.resolve({ host: profile.host, port: profile.relayPort }),
    );
    const { result, rerender } = renderHook(({ active }) => usePlanUsage([PESSOAL, TRABALHO], active), {
      initialProps: { active: "pessoal" },
    });
    await settle();
    expect(result.current.byProfile.trabalho.connection).toBe("offline");

    await settle(59_999);
    expect(wakesFor("trabalho")).toEqual([false]);
    await settle(1);
    expect(wakesFor("trabalho")).toEqual([false, false]);

    rerender({ active: "trabalho" });
    await settle();
    expect(wakesFor("trabalho")).toEqual([false, false, true]);
    expect(result.current.byProfile.trabalho.connection).toBe("live");
  });

  it("sends a refresh to one profile or to all, and spins until the answer", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [] }, "127.0.0.1:8002": { runtimes: [] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL, TRABALHO], "pessoal"));
    await settle();

    act(() => result.current.refresh("trabalho", true));
    expect(result.current.byProfile.trabalho.refreshing).toBe(true);
    expect(refreshes()).toEqual([{ url: "ws://127.0.0.1:8002/plan-usage/watch", message: { type: "plan_usage_refresh", force: true } }]);
    // Sent with a ping, so a dead socket would be caught.
    expect(pings().map((entry) => entry.url)).toEqual(["ws://127.0.0.1:8002/plan-usage/watch"]);
    await settle();
    expect(result.current.byProfile.trabalho.refreshing).toBe(false);

    act(() => result.current.refresh());
    expect(refreshes().slice(1).map((entry) => [entry.url, entry.message])).toEqual([
      ["ws://127.0.0.1:8001/plan-usage/watch", { type: "plan_usage_refresh", force: false }],
      ["ws://127.0.0.1:8002/plan-usage/watch", { type: "plan_usage_refresh", force: false }],
    ]);
  });

  it("counts a refresh as ours until the read it started is over, and never a read the relay started", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)], readMs: 2_000 } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    // The relay's own minute read: not ours.
    act(() => relay.emitPlanUsage("127.0.0.1:8001", [{ ...claude(10), reading: true }]));
    expect(result.current.byProfile.pessoal.refreshing).toBe(false);
    act(() => relay.emitPlanUsage("127.0.0.1:8001", [claude(10)]));

    act(() => result.current.refresh("pessoal", true));
    await settle();
    // Answered with "reading started": still ours.
    expect(result.current.byProfile.pessoal.runtimes?.[0].reading).toBe(true);
    expect(result.current.byProfile.pessoal.refreshing).toBe(true);
    await settle(2_000);
    expect(result.current.byProfile.pessoal.refreshing).toBe(false);
  });

  it("stops spinning when a refresh goes unanswered", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    // An answer that never comes: the fake only answers what is scripted.
    relay.planUsage!["127.0.0.1:8001"] = "legacy";
    act(() => result.current.refresh("pessoal", true));
    expect(result.current.byProfile.pessoal.refreshing).toBe(true);
    await settle(REFRESH_TIMEOUT_MS);
    expect(result.current.byProfile.pessoal.refreshing).toBe(false);
  });

  it("finds a dead socket on refresh, redials at once and sends the refresh again", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    const [dead] = planSockets();
    // The connection died without a close frame: still OPEN, answering nothing.
    relay.silentPlanUsage("127.0.0.1:8001");
    relay.planUsage!["127.0.0.1:8001"] = { runtimes: [claude(64)] };

    act(() => result.current.refresh("pessoal", true));
    expect(result.current.byProfile.pessoal.refreshing).toBe(true);
    await settle(PONG_TIMEOUT_MS - 1);
    expect(planSockets()).toHaveLength(1);
    await settle(1);

    expect(dead.readyState).toBe(3);
    expect(planSockets()).toHaveLength(2);
    expect(refreshes().map((entry) => entry.url)).toEqual(["ws://127.0.0.1:8001/plan-usage/watch", "ws://127.0.0.1:8001/plan-usage/watch"]);
    // The first went out forced; the resend after the dead socket is a
    // plain resync, never a second forced read.
    expect(refreshes().map((entry) => entry.message.force)).toEqual([true, false]);
    // Spinning until the answer to the resent refresh, then the new numbers.
    await settle();
    expect(result.current.byProfile.pessoal.refreshing).toBe(false);
    expect(result.current.byProfile.pessoal).toMatchObject({ connection: "live" });
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(64);
  });

  it("keeps a live socket that answers its ping", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    act(() => result.current.refresh("pessoal", false));
    await settle(PONG_TIMEOUT_MS * 2);
    expect(planSockets()).toHaveLength(1);
    expect(planSockets()[0].readyState).toBe(1);
  });

  it("never turns a flaky connection into repeated forced refreshes", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    // Every connection dies silently right after its snapshot.
    for (let round = 0; round < 4; round++) {
      relay.silentPlanUsage("127.0.0.1:8001");
      if (round === 0) act(() => result.current.refresh("pessoal", true));
      else act(() => window.dispatchEvent(new Event("focus")));
      await settle(PONG_TIMEOUT_MS);
      await settle();
    }
    expect(refreshes().filter((entry) => entry.message.force === true)).toHaveLength(1);
  });

  it("dials at once for a refresh asked while waiting out a retry", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": "unreachable" } });
    const { result } = renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    expect(result.current.byProfile.pessoal.connection).toBe("offline");
    relay.planUsage!["127.0.0.1:8001"] = { runtimes: [claude(33)] };
    act(() => result.current.refresh("pessoal", true));
    expect(result.current.byProfile.pessoal.refreshing).toBe(true);
    await settle();
    expect(refreshes()).toEqual([{ url: "ws://127.0.0.1:8001/plan-usage/watch", message: { type: "plan_usage_refresh", force: true } }]);
    expect(result.current.byProfile.pessoal.refreshing).toBe(false);
    expect(result.current.byProfile.pessoal.runtimes?.[0].windows[0].usedPercent).toBe(33);
  });

  it("pings on a timer while visible, and drops a socket that stopped answering", async () => {
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    renderHook(() => usePlanUsage([PESSOAL], "pessoal"));
    await settle();
    const before = pings().length;
    await settle(PING_INTERVAL_MS);
    expect(pings().length).toBe(before + 1);

    relay.silentPlanUsage("127.0.0.1:8001");
    await settle(PING_INTERVAL_MS + PONG_TIMEOUT_MS);
    expect(planSockets()[0].readyState).toBe(3);
    expect(planSockets()).toHaveLength(2);
    expect(planSockets()[1].readyState).toBe(1);
  });

  it("never pings a brokered profile on a timer", async () => {
    const brokered: Profile = { ...PESSOAL, brokerUrl: "https://broker.test/w", brokerNodeId: "node" };
    resolveSpy.mockImplementation((profile) => Promise.resolve({ host: profile.host, port: profile.relayPort }));
    relay = installFakeRelay(undefined, { planUsage: { "127.0.0.1:8001": { runtimes: [claude(10)] } } });
    renderHook(() => usePlanUsage([brokered], "pessoal"));
    await settle();
    const before = pings().length;
    await settle(PING_INTERVAL_MS * 3);
    expect(pings().length).toBe(before);
  });

  it("moves its clock every minute", async () => {
    relay = installFakeRelay(undefined, { planUsage: {} });
    const { result } = renderHook(() => usePlanUsage([], null));
    expect(result.current.now).toBe(NOW);
    await settle(PLAN_USAGE_CLOCK_MS);
    expect(result.current.now).toBe(NOW + PLAN_USAGE_CLOCK_MS);
  });

  it("closes the socket of a removed profile and redials one whose address changed", async () => {
    relay = installFakeRelay(undefined, {
      planUsage: { "127.0.0.1:8001": { runtimes: [] }, "127.0.0.1:8002": { runtimes: [] }, "127.0.0.1:8003": { runtimes: [] } },
    });
    const { result, rerender, unmount } = renderHook(({ list }) => usePlanUsage(list, "pessoal"), {
      initialProps: { list: [PESSOAL, TRABALHO] },
    });
    await settle();
    const [pessoal, trabalho] = planSockets();

    rerender({ list: [{ ...PESSOAL }] });
    await settle();
    expect(trabalho.readyState).toBe(3);
    expect(pessoal.readyState).toBe(1);
    expect(Object.keys(result.current.byProfile)).toEqual(["pessoal"]);

    rerender({ list: [{ ...PESSOAL, relayPort: 8003 }] });
    await settle();
    expect(pessoal.readyState).toBe(3);
    expect(planSockets()[planSockets().length - 1].url).toBe("ws://127.0.0.1:8003/plan-usage/watch");
    expect(result.current.byProfile.pessoal.connection).toBe("live");

    unmount();
    expect(planSockets().every((socket) => socket.readyState === 3)).toBe(true);
  });
});
