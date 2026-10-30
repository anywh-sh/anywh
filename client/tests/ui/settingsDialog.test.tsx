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
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));

let relay: FakeRelay;
let patchCalls: { url: string; body: unknown }[];
let legacyRelay = false;

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
  relay = installFakeRelay();
  patchCalls = [];
  legacyRelay = false;

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
      if (url.endsWith("/host-info")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              hostname: "h",
              platform: "linux",
              editor: null,
              agents: [
                { id: "claude", capabilities: {} },
                { id: "codex", capabilities: {} },
              ],
            }),
        } as Response);
      }
      if (init?.method === "PATCH" && url.includes("/control/profiles/default")) {
        const body = JSON.parse(String(init.body)) as { label?: string; colorIndex?: number; agentPreference?: unknown };
        patchCalls.push({ url, body });
        if (legacyRelay && body.agentPreference !== undefined) {
          return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "label or colorIndex is required" }) } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "default",
              label: body.label ?? "Default",
              colorIndex: body.colorIndex ?? 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              ...(body.agentPreference !== undefined ? { agentPreference: body.agentPreference } : {}),
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

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Menu" }));
    await user.click(await within(document.body).findByText(en.shell.titleBar.settings));
    return screen.findByRole("dialog");
  }

  it("pinning the default agent PATCHes a fixed preference, and going back to last used clears the pin", async () => {
    const user = userEvent.setup();
    const dialog = await openSettings(user);
    const agentRow = within(dialog).getByText(en.settings.profile.agent.title).closest("div")?.parentElement as HTMLElement;

    const always = await within(agentRow).findByRole("button", { name: en.settings.profile.agent.fixed });
    await vi.waitFor(() => expect(always).toBeEnabled());
    await user.click(always);
    await vi.waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].body).toEqual({ agentPreference: { mode: "fixed", fixedAgentId: "claude" } });

    await user.click(await within(agentRow).findByRole("button", { name: "Codex" }));
    await vi.waitFor(() => expect(patchCalls).toHaveLength(2));
    expect(patchCalls[1].body).toEqual({ agentPreference: { mode: "fixed", fixedAgentId: "codex" } });
    // The choice is announced as pressed, not only drawn as such.
    await vi.waitFor(() => expect(within(agentRow).getByRole("button", { name: "Codex" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(agentRow).getByRole("button", { name: en.settings.profile.agent.fixed })).toHaveAttribute("aria-pressed", "true");
    expect(within(agentRow).getByRole("button", { name: en.settings.profile.agent.lastUsed })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(agentRow).getByRole("button", { name: en.settings.profile.agent.lastUsed }));
    await vi.waitFor(() => expect(patchCalls).toHaveLength(3));
    expect(patchCalls[2].body).toEqual({ agentPreference: { mode: "lastUsed" } });
  });

  it("a relay that answers the agent preference with 400 disables the control and says why", async () => {
    legacyRelay = true;
    const user = userEvent.setup();
    const dialog = await openSettings(user);
    const agentRow = within(dialog).getByText(en.settings.profile.agent.title).closest("div")?.parentElement as HTMLElement;

    const always = await within(agentRow).findByRole("button", { name: en.settings.profile.agent.fixed });
    await vi.waitFor(() => expect(always).toBeEnabled());
    await user.click(always);

    await vi.waitFor(() => expect(always).toBeDisabled());
    expect(within(agentRow).getByText(en.settings.profile.agent.unsupported)).toBeInTheDocument();
  });
});
