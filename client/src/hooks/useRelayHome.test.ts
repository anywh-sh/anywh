import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Profile } from "@/lib/profiles/profiles";

// The relay's folder listing is the boundary, as in FolderPickerDialog's test.
const relay = vi.hoisted(() => ({ listDirectories: vi.fn() }));
vi.mock("@/lib/relay/fsBrowse", () => relay);

import { relayHome, useRelayHome } from "./useRelayHome";

afterEach(() => relay.listDirectories.mockReset());

// The cache lives for the app's run, so each test asks about its own relay.
function profileFor(id: string): Profile {
  return { id, label: id, host: "localhost", relayPort: 4317 };
}

describe("relayHome", () => {
  it("asks the relay once, for the folder it lists without a path", async () => {
    relay.listDirectories.mockResolvedValue({ path: "/home/wil", entries: [] });
    const profile = profileFor("once");
    expect(await relayHome(profile)).toBe("/home/wil");
    expect(await relayHome(profile)).toBe("/home/wil");
    expect(relay.listDirectories).toHaveBeenCalledTimes(1);
    expect(relay.listDirectories).toHaveBeenCalledWith(profile);
  });

  it("asks again after a failure", async () => {
    relay.listDirectories.mockRejectedValueOnce(new Error("Load failed")).mockResolvedValue({ path: "/home/wil", entries: [] });
    const profile = profileFor("retry");
    expect(await relayHome(profile)).toBeNull();
    expect(await relayHome(profile)).toBe("/home/wil");
  });
});

describe("useRelayHome", () => {
  it("is null until known, and only while enabled", async () => {
    relay.listDirectories.mockResolvedValue({ path: "/home/ana", entries: [] });
    const profile = profileFor("hook");
    const { result, rerender } = renderHook(({ enabled }) => useRelayHome(profile, enabled), { initialProps: { enabled: false } });
    expect(result.current).toBeNull();
    expect(relay.listDirectories).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toBe("/home/ana"));
    rerender({ enabled: false });
    expect(result.current).toBeNull();
  });
});
