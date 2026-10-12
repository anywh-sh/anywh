import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { invokeMock, isIOSMock, pushActiveMock } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve()),
  isIOSMock: vi.fn(() => false),
  pushActiveMock: vi.fn((_profileId: string) => false),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: () => Promise.resolve(true), requestPermission: () => Promise.resolve("granted") }));
vi.mock("@/lib/platform/tauri", () => ({ inTauri: () => true }));
vi.mock("@/lib/platform/platform", () => ({ isIOS: isIOSMock }));
vi.mock("@/lib/platform/pushRegistration", () => ({ isPushActive: pushActiveMock }));

import { ensureNotificationPermission, notifyTurnComplete, shouldNotifyLocally } from "./notifications";

const profile: Profile = { id: "pessoal", label: "Pessoal", host: "h", relayPort: 1 };

beforeEach(async () => {
  invokeMock.mockClear();
  isIOSMock.mockReturnValue(false);
  pushActiveMock.mockReturnValue(false);
  await ensureNotificationPermission();
});

describe("shouldNotifyLocally", () => {
  it("is false only for an iPhone whose relay is sending the notification itself", () => {
    expect(shouldNotifyLocally(true, true)).toBe(false);
    expect(shouldNotifyLocally(true, false)).toBe(true);
    expect(shouldNotifyLocally(false, true)).toBe(true);
    expect(shouldNotifyLocally(false, false)).toBe(true);
  });
});

describe("notifyTurnComplete", () => {
  const notify = () => notifyTurnComplete("tab-1", profile, "Fix build", "run tests", "All **green**.", false);

  it("notifies locally on desktop, with the same body as before", () => {
    notify();
    expect(invokeMock).toHaveBeenCalledWith("notify_turn_complete", { title: "Fix build", body: "All green.", sessionId: "tab-1", profileId: "pessoal" });
  });

  it("notifies locally on iOS for a profile whose relay has no push", () => {
    isIOSMock.mockReturnValue(true);
    notify();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent on iOS for a profile whose relay pushes, including for a stopped turn", () => {
    isIOSMock.mockReturnValue(true);
    pushActiveMock.mockImplementation((id) => id === "pessoal");
    notify();
    notifyTurnComplete("tab-1", profile, "Fix build", null, null, true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("asks about the profile the turn belongs to, not another one", () => {
    isIOSMock.mockReturnValue(true);
    pushActiveMock.mockImplementation((id) => id === "trabalho");
    notify();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(pushActiveMock).toHaveBeenCalledWith("pessoal");
  });
});
