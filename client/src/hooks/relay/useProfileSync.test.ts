import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";
import type { RemoteProfile } from "@/lib/relay/relay-types";

const { fetchControlProfilesMock, syncProfilesForHostMock, resolveConnectionMock } = vi.hoisted(() => ({
  fetchControlProfilesMock: vi.fn(async (): Promise<RemoteProfile[]> => []),
  syncProfilesForHostMock: vi.fn(),
  resolveConnectionMock: vi.fn(),
}));
vi.mock("@/lib/relay/relayClient", () => ({ fetchControlProfiles: fetchControlProfilesMock }));
vi.mock("@/lib/profiles/connectionResolver", () => ({ resolveConnection: resolveConnectionMock }));
vi.mock("@/lib/profiles/profiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/profiles")>()),
  syncProfilesForHost: syncProfilesForHostMock,
}));

import { useProfileSync } from "@/hooks/relay/useProfileSync";

// Every tailnet profile shares the same placeholder host —
// only `id` tells them apart.
const tailnetProfile: Profile = {
  id: "sandbox-a",
  label: "Sandbox A",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

const directProfile: Profile = {
  id: "pessoal",
  label: "Pessoal",
  host: "100.64.0.9",
  relayPort: 8765,
};

beforeEach(() => {
  fetchControlProfilesMock.mockClear().mockResolvedValue([]);
  syncProfilesForHostMock.mockClear();
  resolveConnectionMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 54321, token: "grant-token" });
});

afterEach(() => {
  cleanup();
});

describe("useProfileSync", () => {
  it("fetches through the resolved connection but stores the sync under the profile's own advertised host", async () => {
    await act(async () => {
      renderHook(({ profile }) => useProfileSync(profile), { initialProps: { profile: directProfile } });
    });

    expect(fetchControlProfilesMock).toHaveBeenCalledWith("127.0.0.1", 54321, "grant-token");
    // `syncProfilesForHost` keys deduping/dropping by the profile's *own*
    // host field, never the sidecar's resolved local port — passing the
    // resolved host would break the dedup logic in profiles.ts for every
    // subsequent sync.
    expect(syncProfilesForHostMock).toHaveBeenCalledWith(directProfile.host, []);
  });

  // A live bug report: a tailnet profile's own `host` is a
  // placeholder ("127.0.0.1"), never a real dial target — every entry
  // `/control/profiles` returns for it describes a profile on the *remote*
  // machine's own loopback (e.g. the sandbox relay's own
  // `ensureSelfRegistered` "Default"), unreachable from here. Merging that
  // in surfaced live as a phantom "Default" entry in the switcher that
  // flickered in and out depending on which profile was synced last.
  it("never merges control-profiles entries for a tailnet profile", async () => {
    fetchControlProfilesMock.mockResolvedValue([
      { id: "default", label: "Default", colorIndex: 0, host: "127.0.0.1", port: 8765, hasHomeOverride: false, running: true },
    ]);

    await act(async () => {
      renderHook(({ profile }) => useProfileSync(profile), { initialProps: { profile: tailnetProfile } });
    });

    expect(fetchControlProfilesMock).toHaveBeenCalledWith("127.0.0.1", 54321, "grant-token");
    expect(syncProfilesForHostMock).not.toHaveBeenCalled();
  });

  it("doesn't apply a stale response after switching to a different direct profile sharing the same host", async () => {
    let resolveFirstFetch: (value: never[]) => void = () => undefined;
    fetchControlProfilesMock.mockImplementationOnce(
      () => new Promise((resolve: (value: never[]) => void) => { resolveFirstFetch = resolve; }),
    );

    const { rerender } = renderHook(({ profile }) => useProfileSync(profile), {
      initialProps: { profile: directProfile },
    });

    const otherDirectProfile: Profile = { ...directProfile, id: "trabalho" };
    await act(async () => {
      rerender({ profile: otherDirectProfile });
    });

    await act(async () => {
      resolveFirstFetch([]);
      await Promise.resolve();
    });

    // The first profile's late response must not have counted as a sync —
    // only the second profile's own (immediate, already-resolved) fetch did.
    expect(syncProfilesForHostMock).toHaveBeenCalledTimes(1);
  });
});
