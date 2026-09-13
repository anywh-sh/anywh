import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles";

const { removeProfileMock } = vi.hoisted(() => ({
  removeProfileMock: vi.fn(() => true),
}));
vi.mock("@/lib/profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/profiles")>();
  return { ...actual, removeProfile: removeProfileMock };
});

import { DangerZone, findSameHostExecutor } from "./DangerZone";

function directProfile(id: string, host: string): Profile {
  return { id, label: id, host, relayPort: 8765 };
}

function tailnetProfile(id: string): Profile {
  return {
    id,
    label: id,
    // Every tailnet profile reports this same placeholder host — never a
    // real, shared machine (see ThemeSection's registry comment).
    host: "127.0.0.1",
    relayPort: 0,
    tailnetAuthKey: "key",
    tailnetControlUrl: "https://headscale.test",
    tailnetTarget: "100.64.0.1:8443",
  };
}

describe("findSameHostExecutor", () => {
  it("finds another profile on the same real host as a valid executor (direct mode, unchanged)", () => {
    const scoped = directProfile("a", "192.168.0.10");
    const other = directProfile("b", "192.168.0.10");
    expect(findSameHostExecutor(scoped, [scoped, other])).toBe(other);
  });

  it("never treats another tailnet profile as an executor — each is its own isolated sandbox", () => {
    const scoped = tailnetProfile("sandbox-a");
    const other = tailnetProfile("sandbox-b");
    expect(findSameHostExecutor(scoped, [scoped, other])).toBeUndefined();
  });

  it("never treats a tailnet profile as an executor for a direct profile just because they share the placeholder host", () => {
    const scoped = directProfile("direct", "127.0.0.1");
    const sandbox = tailnetProfile("sandbox-a");
    expect(findSameHostExecutor(scoped, [scoped, sandbox])).toBeUndefined();
  });
});

describe("DangerZone", () => {
  afterEach(() => {
    cleanup();
    removeProfileMock.mockReset().mockReturnValue(true);
  });

  it("offers a local-only removal for a tailnet profile, never the disabled server-delete button", async () => {
    const scoped = tailnetProfile("sandbox-a");
    render(<DangerZone scopedProfile={scoped} allProfiles={[scoped]} onProfileRemoved={() => {}} />);

    // Not the server-delete flow's disabled button — a tailnet profile has
    // no host to call, so it gets its own always-enabled "remove" action
    // instead of a permanently disabled "delete".
    const removeButton = screen.getByRole("button", { name: en.settings.danger.remove });
    expect(removeButton).toBeEnabled();

    const user = userEvent.setup();
    await user.click(removeButton);

    const dialog = within(await screen.findByRole("dialog"));
    const confirmButton = dialog.getByRole("button", { name: en.settings.danger.remove });
    expect(confirmButton).toBeDisabled();

    await user.type(dialog.getByRole("textbox"), "sandbox-a");
    await user.click(confirmButton);

    expect(removeProfileMock).toHaveBeenCalledWith("sandbox-a");
  });

  it("keeps the confirmation armed only for the exact name", async () => {
    const scoped = tailnetProfile("sandbox-a");
    render(<DangerZone scopedProfile={scoped} allProfiles={[scoped]} onProfileRemoved={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: en.settings.danger.remove }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByRole("textbox"), "sandbox");

    expect(dialog.getByRole("button", { name: en.settings.danger.remove })).toBeDisabled();
    expect(removeProfileMock).not.toHaveBeenCalled();
  });

  it("keeps the server-delete flow, disabled with no executor, for a direct profile", () => {
    const scoped = directProfile("solo", "192.168.0.10");
    render(<DangerZone scopedProfile={scoped} allProfiles={[scoped]} onProfileRemoved={() => {}} />);

    expect(screen.getByRole("button", { name: en.settings.danger.delete })).toBeDisabled();
  });

  it("says what removing the only profile means, and removes it anyway", async () => {
    // Removing the last profile used to be refused with "add another one
    // first". An empty list is legitimate now — it puts the first-run
    // screen back — so the zone says so up front and the removal goes
    // through.
    const scoped = tailnetProfile("only-one");
    render(<DangerZone scopedProfile={scoped} allProfiles={[scoped]} onProfileRemoved={() => {}} />);
    expect(screen.getByText(en.settings.danger.lastProfile)).toBeInTheDocument();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: en.settings.danger.remove }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.type(dialog.getByRole("textbox"), "only-one");
    await user.click(dialog.getByRole("button", { name: en.settings.danger.remove }));

    expect(removeProfileMock).toHaveBeenCalledWith("only-one");
  });

  it("leaves that sentence out while other profiles remain", () => {
    const scoped = tailnetProfile("sandbox-a");
    const other = directProfile("b", "192.168.0.10");
    render(<DangerZone scopedProfile={scoped} allProfiles={[scoped, other]} onProfileRemoved={() => {}} />);

    expect(screen.queryByText(en.settings.danger.lastProfile)).not.toBeInTheDocument();
  });
});
