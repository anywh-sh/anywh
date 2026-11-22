import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallDoneEvent } from "@/lib/install/localRelay";

// The installer is the Tauri side: what it emits is scripted here.
const install = vi.hoisted(() => ({
  listeners: new Set<(event: InstallDoneEvent) => void>(),
  start: (): Promise<{ runId: string }> => Promise.resolve({ runId: "r1" }),
}));
vi.mock("@/lib/install/localRelay", () => ({
  onInstallDone: (handler: (event: InstallDoneEvent) => void) => {
    install.listeners.add(handler);
    return Promise.resolve(() => install.listeners.delete(handler));
  },
  startLocalInstall: () => install.start(),
}));
vi.mock("@/hooks/platform/useLocalRelayProbe", () => ({ useLocalRelayProbe: () => ({ installedVersion: "0.2.0", profiles: [] }) }));
vi.mock("@/lib/platform/platform", () => ({ currentPlatform: () => "linux" }));

const { useRelayUpdate } = await import("@/hooks/relay/useRelayUpdate");
const profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 1 };
const emit = (event: Partial<InstallDoneEvent>): void => {
  for (const listener of [...install.listeners]) listener({ runId: "r1", ok: true, ...event } as InstallDoneEvent);
};

describe("useRelayUpdate", () => {
  afterEach(() => install.listeners.clear());

  it("an install that ends before its start resolves still settles the update", async () => {
    install.start = () => {
      emit({ ok: true });
      return Promise.resolve({ runId: "r1" });
    };
    const { result } = renderHook(() => useRelayUpdate(profile));
    await act(() => result.current.run());
    expect(result.current.status).toBe("done");
    expect(install.listeners.size).toBe(0);
  });

  it("only its own run's end counts, and the listener goes when the hook unmounts", async () => {
    install.start = () => Promise.resolve({ runId: "r1" });
    const { result, unmount } = renderHook(() => useRelayUpdate(profile));
    await act(() => result.current.run());
    act(() => emit({ runId: "other", ok: true }));
    expect(result.current.status).toBe("running");
    unmount();
    expect(install.listeners.size).toBe(0);
  });
});
