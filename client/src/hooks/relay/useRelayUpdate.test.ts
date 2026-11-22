import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallDoneEvent } from "@/lib/install/localRelay";

// The installer is the Tauri side: what it emits is scripted here.
const install = vi.hoisted(() => ({
  listeners: new Set<(event: InstallDoneEvent) => void>(),
  start: (): Promise<{ runId: string }> => Promise.resolve({ runId: "r1" }),
  restarted: [] as string[],
  restart: (profileId: string): Promise<void> => {
    install.restarted.push(profileId);
    return Promise.resolve();
  },
}));
vi.mock("@/lib/install/localRelay", () => ({
  onInstallDone: (handler: (event: InstallDoneEvent) => void) => {
    install.listeners.add(handler);
    return Promise.resolve(() => install.listeners.delete(handler));
  },
  startLocalInstall: () => install.start(),
  restartLocalRelay: (profileId: string) => install.restart(profileId),
}));
vi.mock("@/hooks/platform/useLocalRelayProbe", () => ({ useLocalRelayProbe: () => ({ installedVersion: "0.2.0", profiles: [] }) }));
vi.mock("@/lib/platform/platform", () => ({ currentPlatform: () => "linux" }));

const { useRelayUpdate } = await import("@/hooks/relay/useRelayUpdate");
const profile = { id: "p", label: "P", host: "127.0.0.1", relayPort: 1 };
const emit = (event: Partial<InstallDoneEvent>): void => {
  for (const listener of [...install.listeners]) listener({ runId: "r1", ok: true, ...event } as InstallDoneEvent);
};

/** Starts an update without waiting for it to end (it ends when the test
 * emits the installer's done event), once the installer is listened to. */
async function startRun(run: () => Promise<void>): Promise<void> {
  act(() => void run());
  await waitFor(() => expect(install.listeners.size).toBe(1));
}

describe("useRelayUpdate", () => {
  afterEach(() => {
    install.listeners.clear();
    install.restarted = [];
  });

  it("an install that ends before its start resolves still settles the update", async () => {
    install.start = () => {
      emit({ ok: true });
      return Promise.resolve({ runId: "r1" });
    };
    const { result } = renderHook(() => useRelayUpdate(profile));
    await act(() => result.current.run());
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(install.listeners.size).toBe(0);
  });

  it("a successful install restarts the profile's relay, so the new release is what runs", async () => {
    install.start = () => Promise.resolve({ runId: "r1" });
    const { result } = renderHook(() => useRelayUpdate(profile));
    await startRun(() => result.current.run());
    expect(install.restarted).toEqual([]);
    act(() => emit({ ok: true }));
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(install.restarted).toEqual(["p"]);
  });

  it("a failed install never restarts the relay, and a failed restart is reported", async () => {
    install.start = () => Promise.resolve({ runId: "r1" });
    const { result } = renderHook(() => useRelayUpdate(profile));
    await startRun(() => result.current.run());
    act(() => emit({ ok: false, failure: { message: "no network" } } as Partial<InstallDoneEvent>));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(install.restarted).toEqual([]);
    expect(result.current.error).toBe("no network");

    install.restart = () => Promise.reject(new Error("systemctl said no"));
    await startRun(() => result.current.run());
    act(() => emit({ ok: true }));
    await waitFor(() => expect(result.current.error).toBe("systemctl said no"));
    expect(result.current.status).toBe("failed");
  });

  it("only its own run's end counts, and the listener goes when the hook unmounts", async () => {
    install.start = () => Promise.resolve({ runId: "r1" });
    const { result, unmount } = renderHook(() => useRelayUpdate(profile));
    await startRun(() => result.current.run());
    act(() => emit({ runId: "other", ok: true }));
    expect(result.current.status).toBe("running");
    unmount();
    expect(install.listeners.size).toBe(0);
  });
});
