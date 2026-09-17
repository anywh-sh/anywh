import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { fetchThemesMock, setThemesForHostMock, resolveConnectionMock } = vi.hoisted(() => ({
  fetchThemesMock: vi.fn(async () => []),
  setThemesForHostMock: vi.fn(),
  resolveConnectionMock: vi.fn(),
}));
vi.mock("@/lib/relay/relayClient", () => ({ fetchThemes: fetchThemesMock }));
vi.mock("@/lib/profiles/connectionResolver", () => ({ resolveConnection: resolveConnectionMock }));
vi.mock("@/lib/theme/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/theme/themes")>()),
  setThemesForHost: setThemesForHostMock,
}));

import { useThemeSync } from "@/hooks/relay/useThemes";

const tailnetProfileA: Profile = {
  id: "sandbox-a",
  label: "Sandbox A",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

beforeEach(() => {
  fetchThemesMock.mockClear().mockResolvedValue([]);
  setThemesForHostMock.mockClear();
  resolveConnectionMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 54321, token: "grant-token" });
});

afterEach(() => {
  cleanup();
});

describe("useThemeSync", () => {
  it("stores a tailnet profile's synced themes under its own id, not the shared placeholder host", async () => {
    await act(async () => {
      renderHook(({ profile }) => useThemeSync(profile), { initialProps: { profile: tailnetProfileA } });
    });

    expect(fetchThemesMock).toHaveBeenCalledWith("127.0.0.1", 54321, "grant-token");
    expect(setThemesForHostMock).toHaveBeenCalledWith("sandbox-a", []);
  });
});
