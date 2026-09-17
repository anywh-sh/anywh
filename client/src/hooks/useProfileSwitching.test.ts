import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileSwitching } from "@/hooks/useProfileSwitching";
import { addProfile, findProfile, getProfiles, type Profile } from "@/lib/profiles/profiles";
import { clearProfileRevoked, isProfileRevoked, markProfileRevoked } from "@/lib/profiles/profileRevocation";
import type { ProfileSetupSnapshot } from "@/lib/profiles/profileSetup";

function profile(id: string): Profile {
  return { id, label: id, host: "localhost", relayPort: 1 };
}

function readySnapshot(claimedProfile: Profile): ProfileSetupSnapshot {
  return {
    state: { status: "ready", mode: "direct", profile: claimedProfile, info: { sessionCount: 0 }, duplicates: [] },
    queuedCount: 0,
    held: false,
  };
}

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    setActiveProfileId: vi.fn(),
    setDrawerOpen: vi.fn(),
    openTab: vi.fn(),
    setupSnapshot: { state: null, queuedCount: 0, held: false } as ProfileSetupSnapshot,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("useProfileSwitching — handleProfileChange", () => {
  it("switches the active profile and closes the drawer", () => {
    const setActiveProfileId = vi.fn();
    const setDrawerOpen = vi.fn();
    const { result } = renderHook(() => useProfileSwitching(makeArgs({ setActiveProfileId, setDrawerOpen }) as never));
    result.current.handleProfileChange("profile-b");
    expect(setActiveProfileId).toHaveBeenCalledWith("profile-b");
    expect(setDrawerOpen).toHaveBeenCalledWith(false);
  });
});

describe("useProfileSwitching — handleSetupContinue", () => {
  it("switches profile and opens a fresh tab in it, in that order", () => {
    const setActiveProfileId = vi.fn();
    const openTab = vi.fn();
    const calls: string[] = [];
    setActiveProfileId.mockImplementation(() => calls.push("setActiveProfileId"));
    openTab.mockImplementation(() => calls.push("openTab"));
    const { result } = renderHook(() => useProfileSwitching(makeArgs({ setActiveProfileId, openTab }) as never));
    result.current.handleSetupContinue("profile-b");
    expect(calls).toEqual(["setActiveProfileId", "openTab"]);
    expect(openTab).toHaveBeenCalledWith("profile-b", expect.any(String), null, true);
  });
});

describe("useProfileSwitching — handleSetupUseExisting", () => {
  it("does nothing if the setup snapshot isn't ready", () => {
    const setActiveProfileId = vi.fn();
    const { result } = renderHook(() => useProfileSwitching(makeArgs({ setActiveProfileId }) as never));
    result.current.handleSetupUseExisting("profile-existing");
    expect(setActiveProfileId).not.toHaveBeenCalled();
  });

  it("switches to the existing profile and drops the freshly claimed duplicate", () => {
    const newProfile = profile("profile-new");
    addProfile(newProfile);
    const setActiveProfileId = vi.fn();
    const openTab = vi.fn();
    const setupSnapshot = readySnapshot(newProfile);
    const { result } = renderHook(() =>
      useProfileSwitching(makeArgs({ setActiveProfileId, openTab, setupSnapshot }) as never),
    );
    result.current.handleSetupUseExisting("profile-existing");
    expect(setActiveProfileId).toHaveBeenCalledWith("profile-existing");
    expect(openTab).toHaveBeenCalledWith("profile-existing", expect.any(String), null, true);
    expect(findProfile("profile-new")).toBeUndefined();
  });

  it("migrates the fresh credentials onto the existing id when it was revoked, and clears the flag", () => {
    const newProfile = profile("profile-new");
    addProfile(newProfile);
    markProfileRevoked("profile-existing");
    const setupSnapshot = readySnapshot(newProfile);
    const { result } = renderHook(() => useProfileSwitching(makeArgs({ setupSnapshot }) as never));
    result.current.handleSetupUseExisting("profile-existing");
    expect(findProfile("profile-existing")).toEqual(expect.objectContaining({ id: "profile-existing", label: "profile-new" }));
    expect(isProfileRevoked("profile-existing")).toBe(false);
    clearProfileRevoked("profile-existing");
  });

  it("does not touch a non-revoked existing profile's data", () => {
    const newProfile = profile("profile-new");
    const existing = profile("profile-existing");
    addProfile(newProfile);
    addProfile(existing);
    const setupSnapshot = readySnapshot(newProfile);
    const { result } = renderHook(() => useProfileSwitching(makeArgs({ setupSnapshot }) as never));
    result.current.handleSetupUseExisting("profile-existing");
    expect(findProfile("profile-existing")).toEqual(existing);
    expect(getProfiles().some((p) => p.id === "profile-new")).toBe(false);
  });
});
