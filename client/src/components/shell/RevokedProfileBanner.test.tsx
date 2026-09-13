import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles";
import { en } from "@/i18n/en";

const { removeProfileMock } = vi.hoisted(() => ({
  removeProfileMock: vi.fn(() => true),
}));
vi.mock("@/lib/profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles")>();
  return { ...actual, removeProfile: removeProfileMock };
});

import { RevokedProfileBanner, RevokedProfileBanners } from "@/components/shell/RevokedProfileBanner";
import { clearProfileRevoked, markProfileRevoked } from "@/lib/profileRevocation";
import { setProfiles } from "@/lib/profiles";

const copy = en.shell.revoked;

const profile: Profile = { id: "p1", label: "Sandbox", host: "127.0.0.1", relayPort: 8765 };
const otherProfile: Profile = { id: "p2", label: "Trabalho", host: "127.0.0.1", relayPort: 8766 };

afterEach(() => {
  cleanup();
  clearProfileRevoked(profile.id);
  clearProfileRevoked(otherProfile.id);
  removeProfileMock.mockClear();
  localStorage.clear();
});

describe("RevokedProfileBanner", () => {
  it("renders nothing when the profile hasn't been revoked", () => {
    render(<RevokedProfileBanner profile={profile} />);
    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("shows the banner once the profile is marked revoked", () => {
    markProfileRevoked(profile.id);
    render(<RevokedProfileBanner profile={profile} />);
    expect(screen.getByText(copy.eyebrow)).toBeInTheDocument();
  });

  it("removes the profile and hides the banner after confirming", async () => {
    markProfileRevoked(profile.id);
    render(<RevokedProfileBanner profile={profile} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.removeProfile }));
    const confirmButton = await within(document.body).findByRole("button", { name: en.common.remove });
    await user.click(confirmButton);

    expect(removeProfileMock).toHaveBeenCalledWith("p1");
    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("dismisses the banner without removing the profile via the close button", async () => {
    markProfileRevoked(profile.id);
    render(<RevokedProfileBanner profile={profile} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.dismiss }));

    expect(removeProfileMock).not.toHaveBeenCalled();
    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("says what removing the only profile means, then removes it anyway", async () => {
    // Removing the last profile isn't refused anymore — it puts the
    // first-run screen back on the window. That has to be said before the
    // click, in the confirmation, not discovered after it.
    setProfiles([profile]);
    markProfileRevoked(profile.id);
    render(<RevokedProfileBanner profile={profile} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.removeProfile }));
    expect(await within(document.body).findByText(copy.lastProfile)).toBeInTheDocument();

    await user.click(within(document.body).getByRole("button", { name: en.common.remove }));
    expect(removeProfileMock).toHaveBeenCalledWith("p1");
  });

  it("leaves that sentence out while other profiles remain", async () => {
    setProfiles([profile, otherProfile]);
    markProfileRevoked(profile.id);
    render(<RevokedProfileBanner profile={profile} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: copy.removeProfile }));
    await within(document.body).findByRole("button", { name: en.common.remove });

    expect(within(document.body).queryByText(copy.lastProfile)).not.toBeInTheDocument();
  });
});

describe("RevokedProfileBanners", () => {
  it("shows a banner for a revoked profile even when a different one is active/selected", () => {
    // A background chat tab can detect a non-active profile's
    // revocation (TabGroupLayout's flat panel layer keeps its RelayClient alive) — the
    // notification can't be gated on `activeProfile` for that to reach the
    // user without them switching back on their own.
    setProfiles([profile, otherProfile]);
    markProfileRevoked(otherProfile.id);

    render(<RevokedProfileBanners />);

    expect(screen.getByText(otherProfile.label, { exact: false })).toBeInTheDocument();
  });

  it("renders nothing when no profile is revoked", () => {
    setProfiles([profile, otherProfile]);

    render(<RevokedProfileBanners />);

    expect(screen.queryByText(copy.eyebrow)).not.toBeInTheDocument();
  });

  it("stacks one banner per revoked profile", () => {
    setProfiles([profile, otherProfile]);
    markProfileRevoked(profile.id);
    markProfileRevoked(otherProfile.id);

    render(<RevokedProfileBanners />);

    expect(screen.getAllByText(copy.eyebrow)).toHaveLength(2);
  });
});
