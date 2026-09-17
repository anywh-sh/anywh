import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const invokeMock = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "tailnet_sidecar_start") return { addr: "127.0.0.1:12345", nodeKey: "nodekey:abc" };
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// tailnetBroker's own report call isn't this module's concern — covered by
// tailnetBroker.test.ts. Stubbed here so the cold-start path doesn't reach
// for a real fetch/tailnet_sidecar_sign.
const reportTailnetKeyMock = vi.fn(async () => {});
vi.mock("@/lib/profiles/tailnetBroker", () => ({ reportTailnetKey: reportTailnetKeyMock }));

// acquireTailnetSidecar/releaseTailnetSidecar only read `id`, `tailnetAuthKey`
// and `tailnetControlUrl` off a Profile — nothing else in this fixture matters.
function profile(id: string): Profile {
  return { id, label: id, host: "127.0.0.1", relayPort: 0, tailnetAuthKey: "key", tailnetControlUrl: "https://example.test" };
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
  reportTailnetKeyMock.mockClear();
  // acquireTailnetSidecar/releaseTailnetSidecar branch on this — see tauri.ts.
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("tailnetSidecar", () => {
  it("peeks the endpoint of an already-acquired sidecar without touching its ref-count", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar, peekTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "peek-existing";

    const acquired = acquireTailnetSidecar(profile(id), "target:1");
    const peeked = peekTailnetSidecar(id);
    expect(peeked).toBeDefined();
    expect(await peeked).toEqual(await acquired);

    // A peek must not have counted as a reference: the one real
    // `acquireTailnetSidecar` call above is still the only owner, so a
    // single release tears it down.
    releaseTailnetSidecar(id);
    await vi.runAllTimersAsync();
    expect(invokeMock).toHaveBeenCalledWith("tailnet_sidecar_stop", { profileId: id });
  });

  it("peeks nothing for a profile nobody has acquired", async () => {
    const { peekTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    expect(peekTailnetSidecar("never-acquired")).toBeUndefined();
  });

  it("cancels the deferred teardown when the same profile is reacquired before it fires", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "reacquire-before-timeout";

    const first = acquireTailnetSidecar(profile(id), "target:1");
    releaseTailnetSidecar(id);
    // React 18 StrictMode's mount/cleanup/mount replay is exactly this:
    // release then immediately reacquire, synchronously, before any timer
    // has a chance to run.
    const second = acquireTailnetSidecar(profile(id), "target:1");

    await vi.runAllTimersAsync();

    expect(await first).toEqual(await second);
    expect(invokeMock).toHaveBeenCalledTimes(1); // only the one tailnet_sidecar_start
    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());

    releaseTailnetSidecar(id);
    await vi.runAllTimersAsync();
  });

  it("reports the node key a cold start earns, but only once even when a second tab joins the same sidecar", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "report-node-key";
    const p = profile(id);

    const first = acquireTailnetSidecar(p, "target:1");
    const second = acquireTailnetSidecar(p, "target:1"); // joins the same in-flight sidecar
    await Promise.all([first, second]);

    expect(reportTailnetKeyMock).toHaveBeenCalledTimes(1);
    expect(reportTailnetKeyMock).toHaveBeenCalledWith(p, "nodekey:abc");

    releaseTailnetSidecar(id);
    releaseTailnetSidecar(id);
    await vi.runAllTimersAsync();
  });

  it("tears down for real once nothing reacquires it", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "real-teardown";

    await acquireTailnetSidecar(profile(id), "target:1");
    releaseTailnetSidecar(id);
    await vi.runAllTimersAsync();

    expect(invokeMock).toHaveBeenCalledWith("tailnet_sidecar_stop", { profileId: id });
  });

  it("honors a non-zero graceMs — no teardown before the deadline", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "grace-not-elapsed";

    await acquireTailnetSidecar(profile(id), "target:1");
    releaseTailnetSidecar(id, 15_000);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());

    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledWith("tailnet_sidecar_stop", { profileId: id });
  });

  it("cancels a graced teardown when reacquired inside the window", async () => {
    const { acquireTailnetSidecar, releaseTailnetSidecar } = await import("@/lib/profiles/tailnetSidecar");
    const id = "grace-reacquired";

    const first = await acquireTailnetSidecar(profile(id), "target:1");
    releaseTailnetSidecar(id, 15_000);

    await vi.advanceTimersByTimeAsync(5_000);
    const second = await acquireTailnetSidecar(profile(id), "target:1");
    expect(second).toEqual(first);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(invokeMock).not.toHaveBeenCalledWith("tailnet_sidecar_stop", expect.anything());

    releaseTailnetSidecar(id);
    await vi.runAllTimersAsync();
  });
});
