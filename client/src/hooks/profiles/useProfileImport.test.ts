import { StrictMode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProfiles } from "@/lib/profiles/profiles";

const DEEP_LINK_URL =
  "anywh://import-profile/?label=test&joinCode=ABC123&claimUrl=https%3A%2F%2Fexample.test%2Fclaim&brokerUrl=https%3A%2F%2Fexample.test%2Fconnect%2Fw1";

let openUrlHandler: ((urls: string[]) => void) | undefined;

const { getCurrentMock, onOpenUrlMock, claimTailnetBundleMock, enqueueProfileSetupSpy } = vi.hoisted(() => ({
  getCurrentMock: vi.fn(async (): Promise<string[]> => [DEEP_LINK_URL]),
  onOpenUrlMock: vi.fn((_handler: (urls: string[]) => void) => Promise.resolve(() => {})),
  claimTailnetBundleMock: vi.fn(async () => ({ nodeId: "node-1", controlUrl: "https://ctrl.test", authKey: "key" })),
  enqueueProfileSetupSpy: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: () => getCurrentMock(),
  onOpenUrl: (handler: (urls: string[]) => void) => {
    openUrlHandler = handler;
    return onOpenUrlMock(handler);
  },
}));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));

// The one network/Tauri boundary this test needs to cross for real — the
// join code's actual redemption. Everything else (enqueue, dedup, the
// queue/runner) runs unmocked, so the pins below exercise the real thing,
// not a stand-in for it.
vi.mock("@/lib/profiles/tailnetClaim", () => ({ claimTailnetBundle: claimTailnetBundleMock }));
vi.mock("@/lib/profiles/profileSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles/profileSetup")>();
  return {
    ...actual,
    enqueueProfileSetup: (request: Parameters<typeof actual.enqueueProfileSetup>[0]) => {
      enqueueProfileSetupSpy(request);
      return actual.enqueueProfileSetup(request);
    },
  };
});

import { useProfileImport } from "@/hooks/profiles/useProfileImport";
import { __resetProfileSetupForTests, getProfileSetupState } from "@/lib/profiles/profileSetup";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  getCurrentMock.mockClear();
  enqueueProfileSetupSpy.mockClear();
  claimTailnetBundleMock.mockClear();
  onOpenUrlMock.mockClear();
  openUrlHandler = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useProfileImport", () => {
  it("redeems a cold-launch join code exactly once under StrictMode's mount/cleanup/mount replay", async () => {
    renderHook(() => {
      useProfileImport();
    }, { wrapper: StrictMode });

    await vi.runAllTimersAsync();

    // Both StrictMode mounts call getCurrent() (it's cheap, side-effect-free
    // on the native side) — what must happen exactly once is the actual
    // enqueue, and (downstream of that) the actual redemption.
    expect(enqueueProfileSetupSpy).toHaveBeenCalledTimes(1);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues (and redeems) only once even when getCurrent() and onOpenUrl both deliver the same URL", async () => {
    renderHook(() => {
      useProfileImport();
    });
    await vi.runAllTimersAsync();

    openUrlHandler?.([DEEP_LINK_URL]);
    await vi.runAllTimersAsync();

    // The hook itself doesn't dedup — that's profileSetup.ts's job, exercised
    // here unmocked. Two enqueue attempts, one actual claim.
    expect(enqueueProfileSetupSpy).toHaveBeenCalledTimes(2);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetupState().queuedCount).toBe(0);
  });
});
