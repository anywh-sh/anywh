import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { acquireMock, releaseMock, resolveTailnetTargetMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(async () => ({ host: "127.0.0.1", port: 12345 })),
  releaseMock: vi.fn(),
  resolveTailnetTargetMock: vi.fn(async () => ({ target: "100.64.0.1:8765", token: "grant-token" })),
}));
vi.mock("@/lib/profiles/tailnetSidecar", () => ({
  acquireTailnetSidecar: acquireMock,
  releaseTailnetSidecar: releaseMock,
}));
vi.mock("@/lib/profiles/tailnetBroker", () => ({
  resolveTailnetTarget: resolveTailnetTargetMock,
}));

import { useTailnetSidecarOwner } from "@/hooks/profiles/useTailnetSidecarOwner";

const directProfile: Profile = {
  id: "direct-profile",
  label: "Direct",
  host: "192.168.0.10",
  relayPort: 8765,
};

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
  acquireMock.mockClear();
  releaseMock.mockClear();
  resolveTailnetTargetMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTailnetSidecarOwner", () => {
  it("does nothing for a direct profile", async () => {
    renderHook(({ profile }) => { useTailnetSidecarOwner(profile); }, { initialProps: { profile: directProfile } });
    await vi.runAllTimersAsync();
    expect(resolveTailnetTargetMock).not.toHaveBeenCalled();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("acquires the sidecar for a tailnet profile and releases it on unmount", async () => {
    const { unmount } = renderHook(({ profile }) => { useTailnetSidecarOwner(profile); }, {
      initialProps: { profile: tailnetProfile },
    });
    await vi.runAllTimersAsync();

    expect(acquireMock).toHaveBeenCalledWith(tailnetProfile, "100.64.0.1:8765");
    expect(releaseMock).not.toHaveBeenCalled();

    unmount();
    expect(releaseMock).toHaveBeenCalledWith(tailnetProfile.id);
  });

  it("only acquires once under StrictMode's synchronous mount/cleanup/mount replay", async () => {
    const { rerender, unmount } = renderHook(({ profile }) => { useTailnetSidecarOwner(profile); }, {
      initialProps: { profile: tailnetProfile },
    });
    // Same double-invoke shape as useRelayClient.ts's own StrictMode fix:
    // cleanup then remount, synchronously, before the deferred `start()`
    // timer has fired.
    rerender({ profile: tailnetProfile });
    await vi.runAllTimersAsync();

    expect(acquireMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("switches profile: releases the old one, acquires the new one", async () => {
    const { rerender, unmount } = renderHook(({ profile }) => { useTailnetSidecarOwner(profile); }, {
      initialProps: { profile: tailnetProfile },
    });
    await vi.runAllTimersAsync();

    const otherTailnetProfile: Profile = { ...tailnetProfile, id: "other-tailnet-profile" };
    rerender({ profile: otherTailnetProfile });
    await vi.runAllTimersAsync();

    expect(releaseMock).toHaveBeenCalledWith(tailnetProfile.id);
    expect(acquireMock).toHaveBeenCalledWith(otherTailnetProfile, "100.64.0.1:8765");
    unmount();
  });
});
