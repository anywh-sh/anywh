import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const getHostInfo = vi.fn<(profile: Profile) => Promise<{ version?: string; features?: string[] }>>();
vi.mock("@/lib/relay/filesClient", () => ({ getHostInfo: (profile: Profile) => getHostInfo(profile) }));

const { RELAY_FEATURES_RECHECK_MS, lacksFeature, useRelayFeatures } = await import("./useRelayFeatures");

const profile: Profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 1 };

/** Lets the pending `getHostInfo` promise settle inside `act`. */
const flush = () => act(async () => {});

describe("useRelayFeatures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getHostInfo.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("a relay that answers without the list is known to lack the feature; one that cannot be asked is not", async () => {
    getHostInfo.mockResolvedValueOnce({ version: "0.2.40" });
    const answered = renderHook(() => useRelayFeatures(profile));
    await flush();
    expect(lacksFeature(answered.result.current, "bots")).toBe(true);
    expect(answered.result.current.version).toBe("0.2.40");

    getHostInfo.mockRejectedValueOnce(new Error("down"));
    const unreachable = renderHook(() => useRelayFeatures({ ...profile, id: "q" }));
    await flush();
    expect(unreachable.result.current.status).toBe("unknown");
    expect(lacksFeature(unreachable.result.current, "bots")).toBe(false);
  });

  it("watching for a feature, it asks again until the updated relay has it, through a failed check", async () => {
    getHostInfo.mockResolvedValueOnce({ version: "0.2.40" }).mockRejectedValueOnce(new Error("restarting")).mockResolvedValue({ version: "0.2.50", features: ["bots"] });
    const { result } = renderHook(() => useRelayFeatures(profile, "bots"));
    await flush();
    expect(lacksFeature(result.current, "bots")).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(RELAY_FEATURES_RECHECK_MS));
    expect(lacksFeature(result.current, "bots")).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(RELAY_FEATURES_RECHECK_MS));
    expect(lacksFeature(result.current, "bots")).toBe(false);
    expect(getHostInfo).toHaveBeenCalledTimes(3);

    await act(() => vi.advanceTimersByTimeAsync(RELAY_FEATURES_RECHECK_MS * 3));
    expect(getHostInfo).toHaveBeenCalledTimes(3);
  });

  it("without a feature to watch, it asks once", async () => {
    getHostInfo.mockResolvedValue({ version: "0.2.40" });
    renderHook(() => useRelayFeatures(profile));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(RELAY_FEATURES_RECHECK_MS * 3));
    expect(getHostInfo).toHaveBeenCalledTimes(1);
  });
});
