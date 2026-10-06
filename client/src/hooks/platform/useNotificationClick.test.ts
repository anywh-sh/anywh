import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushTap } from "@/lib/platform/nativePush";

const m = vi.hoisted(() => ({
  isIOS: vi.fn(() => true),
  inTauri: vi.fn(() => true),
  order: [] as string[],
  tapListener: null as ((tap: PushTap) => void) | null,
  unregister: vi.fn(),
  pending: null as PushTap | null,
}));
vi.mock("@/lib/platform/platform", () => ({ isIOS: m.isIOS }));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: m.inTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ onAction: () => Promise.resolve({ unregister: () => {} }) }));
vi.mock("@/lib/platform/nativePush", () => ({
  listenPushNotificationClicked: (handler: (tap: PushTap) => void) => {
    m.order.push("listen");
    m.tapListener = handler;
    return Promise.resolve(m.unregister);
  },
  takePendingPushTap: () => {
    m.order.push("take");
    return Promise.resolve(m.pending);
  },
}));

import { pushTapToClick, useNotificationClick } from "./useNotificationClick";

beforeEach(() => {
  m.isIOS.mockReturnValue(true);
  m.inTauri.mockReturnValue(true);
  m.order.length = 0;
  m.tapListener = null;
  m.pending = null;
  m.unregister.mockClear();
});
afterEach(cleanup);

describe("pushTapToClick", () => {
  it("routes a tap that carries its profile, and drops one that does not", () => {
    expect(pushTapToClick({ sessionId: "s1", profileId: "p1" })).toEqual({ sessionId: "s1", profileId: "p1" });
    expect(pushTapToClick({ sessionId: "s1", profileId: null })).toBeNull();
  });
});

describe("useNotificationClick on iOS push taps", () => {
  it("listens first and only then collects a tap that cold-started the app, then routes it", async () => {
    m.pending = { sessionId: "cold", profileId: "p1" };
    const onClick = vi.fn();
    renderHook(() => useNotificationClick(onClick));

    await waitFor(() => expect(onClick).toHaveBeenCalledWith({ sessionId: "cold", profileId: "p1" }));
    expect(m.order).toEqual(["listen", "take"]);
  });

  it("routes a tap that arrives while running", async () => {
    const onClick = vi.fn();
    renderHook(() => useNotificationClick(onClick));
    await waitFor(() => expect(m.tapListener).not.toBeNull());

    m.tapListener?.({ sessionId: "live", profileId: "p2" });
    m.tapListener?.({ sessionId: "orphan", profileId: null });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith({ sessionId: "live", profileId: "p2" });
  });

  it("stops listening when unmounted", async () => {
    const { unmount } = renderHook(() => useNotificationClick(vi.fn()));
    await waitFor(() => expect(m.order).toContain("take"));
    unmount();
    expect(m.unregister).toHaveBeenCalled();
  });

  it("is inert off iOS", async () => {
    m.isIOS.mockReturnValue(false);
    renderHook(() => useNotificationClick(vi.fn()));
    await Promise.resolve();
    expect(m.order).toEqual([]);
  });
});
