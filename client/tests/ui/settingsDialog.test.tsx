import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";

// Same Tauri-API stubs sendMessage.test.tsx needs for ChatPanel to mount at
// all under this tier (see the comment there) — App renders ChatPanel
// behind the Settings dialog regardless of which dialog is open.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

let relay: FakeRelay;
let patchCalls: { url: string; body: unknown }[];

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay();
  patchCalls = [];

  // Settings' "Salvar" flow crosses the network edge via a plain PATCH
  // fetch (relayClient.ts's updateProfileMeta), not the WebSocket the rest
  // of the fake relay covers — installFakeRelay's own fetch stub rejects
  // everything (this tier hasn't needed HTTP before), so this test replaces
  // it with one that answers the one route it actually exercises and
  // otherwise keeps the same "reject, nothing scripted" fallback (e.g. for
  // ThemeSection's GET /control/themes, which already tolerates rejection).
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" && url.includes("/control/profiles/default")) {
        const body = JSON.parse(String(init.body)) as { label?: string; colorIndex?: number };
        patchCalls.push({ url, body });
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: "default",
            label: body.label ?? "Default",
            colorIndex: body.colorIndex ?? 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        } as Response);
      }
      return Promise.reject(new Error("settingsDialog test: HTTP not scripted for this URL"));
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

describe("Settings dialog", () => {
  it("renaming a profile PATCHes the relay and reflects the new label back into the identity field", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Menu" }));
    // DropdownMenuContent is portal-based (Radix) — same trap the tests
    // skill documents for Dialog/Popover/Tooltip: it renders into
    // document.body, not the app's root container.
    await user.click(await within(document.body).findByText(en.shell.titleBar.settings));

    // Opening lands on the active profile's own page — no navigation
    // needed, which is the point of the rail replacing the profile picker.
    const dialog = await screen.findByRole("dialog");

    // The profile name field is a bare, unlabelled native <input> — the only
    // one on this page, so an implicit "textbox" role query scoped to the
    // dialog is unambiguous.
    const labelInput = within(dialog).getByRole("textbox");
    await user.clear(labelInput);
    await user.type(labelInput, "Perfil Renomeado");

    const saveButton = within(dialog).getByRole("button", { name: en.common.save });
    await vi.waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await vi.waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].body).toEqual({ label: "Perfil Renomeado" });

    // addProfile (called after a successful PATCH, SettingsDialog.tsx)
    // updates the shared profiles store — useProfiles re-renders this same
    // row with the new label, resetting the input back to it (the
    // component's own effect), proving the round trip actually landed in
    // app state, not just in the mocked fetch call.
    await vi.waitFor(() => expect(labelInput).toHaveValue("Perfil Renomeado"));
  });

  // Regression for the ternary-to-switch rewrite (SettingsDialog.tsx):
  // `selectedProfile ? <ProfileSettings/> : <AppearanceSettings/>` silently
  // rendered Appearance for every non-profile section once a third one
  // (Updates) existed — picking "Updates" would have shown Appearance
  // instead, with nothing failing loudly.
  it("selecting Updates in the rail renders the Updates page, not Appearance", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await within(document.body).findByText(en.shell.titleBar.settings));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: en.settings.nav.updates }));

    expect(await within(dialog).findByText(en.settings.updates.mode.title)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.settings.appearance.fontSize.title)).not.toBeInTheDocument();

    // And switching back to Appearance renders that page, not a leftover
    // Updates one — the same switch statement covers both directions.
    await user.click(within(dialog).getByRole("button", { name: en.settings.nav.appearance }));
    expect(await within(dialog).findByText(en.settings.appearance.fontSize.title)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.settings.updates.mode.title)).not.toBeInTheDocument();
  });
});
