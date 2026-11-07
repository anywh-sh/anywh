import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeIntegrations, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { SHELL_TEST_PROFILE, seedShellProfile } from "./helpers/seedProfile";
import { setProfiles, type Profile } from "@/lib/profiles/profiles";
import { en } from "@/i18n/en";
import type { IntegrationRuntime, IntegrationState } from "@/lib/integrations/model";

// Same Tauri shims as panelToggles.test.tsx.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };

function runtime(patch: Partial<IntegrationRuntime>): IntegrationRuntime {
  return { runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0, ...patch };
}

function jira(runtimes: IntegrationRuntime[]): IntegrationState {
  return {
    id: "jira",
    provider: "jira",
    runtimes,
    site: { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" },
    prefs: { project: null },
    queries: [],
  };
}

let relay: FakeRelay;

function start(integrations?: FakeIntegrations): void {
  relay = installFakeRelay("fake reply", integrations ? { integrations: { [RELAY]: integrations } } : {});
}

beforeEach(() => {
  localStorage.clear();
  seedShellProfile();
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function openConversation(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  renderApp();
  await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
  await screen.findByLabelText(en.chat.composer.placeholder, undefined, SLOW);
  return screen.findByTestId("dock-rail");
}

const jiraLabel = (count: number) =>
  (count === 1 ? en.integrations.rail.needsAuthOne : en.integrations.rail.needsAuthMany).replace("{name}", "Jira").replace("{count}", String(count));

describe("integrations on the side panel rail", () => {
  it("shows Jira between the divider and the +, badged amber while an agent has to sign in", async () => {
    start({ integrations: [jira([runtime({ status: "needs_auth" }), runtime({ runtimeId: "codex", status: "needs_auth" })])] });
    const user = userEvent.setup();
    const rail = await openConversation(user);

    const button = await within(rail).findByRole("button", { name: jiraLabel(2) });
    const add = within(rail).getByRole("button", { name: en.panels.addView });
    const divider = rail.querySelector('[aria-hidden="true"].h-px');
    expect(divider).not.toBeNull();
    expect(divider!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.querySelector('[data-rail-badge="needs_auth"]')).not.toBeNull();

    // A connected Jira has no badge; one with another agent's server failed is red.
    relay.emitIntegrations(RELAY, [jira([runtime({})])]);
    const clean = await within(rail).findByRole("button", { name: "Jira" });
    expect(clean.querySelector("[data-rail-badge]")).toBeNull();
    relay.emitIntegrations(RELAY, [jira([runtime({ status: "failed" }), runtime({ runtimeId: "codex" })])]);
    const failed = await within(rail).findByRole("button", { name: en.integrations.rail.failed.replace("{name}", "Jira") });
    expect(failed.querySelector('[data-rail-badge="failed"]')).not.toBeNull();

    // A Jira no agent reads nor can sign in to is not one the profile has.
    relay.emitIntegrations(RELAY, [jira([runtime({ status: "failed" }), runtime({ runtimeId: "codex", status: "unknown" })])]);
    await waitFor(() => expect(rail.querySelector("[data-integration]")).toBeNull());
  });

  it("opens the integration's pane from its button and closes it again", async () => {
    start({ integrations: [jira([runtime({})])] });
    const user = userEvent.setup();
    const rail = await openConversation(user);

    await user.click(await within(rail).findByRole("button", { name: "Jira" }));
    const header = await screen.findByTestId("integration-panel-header");
    expect(header).toHaveTextContent("Jira");
    expect(header).toHaveTextContent("acme.atlassian.net");
    expect(within(rail).getByRole("button", { name: "Jira" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(rail).getByRole("button", { name: "Jira" }));
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Jira" })).toHaveAttribute("aria-pressed", "false"));
  });

  it("drops the icon when the relay no longer reports a server for it", async () => {
    start({ integrations: [jira([runtime({})])] });
    const user = userEvent.setup();
    const rail = await openConversation(user);
    await within(rail).findByRole("button", { name: "Jira" });

    relay.emitIntegrations(RELAY, [jira([])]);
    await waitFor(() => expect(within(rail).queryByRole("button", { name: "Jira" })).toBeNull());
    relay.emitIntegrations(RELAY, []);
    await waitFor(() => expect(within(rail).queryByRole("button", { name: "Jira" })).toBeNull());
  });

  it("shows Jira only on the tabs of a profile whose agents have it", async () => {
    const other: Profile = { id: "pessoal", label: "Pessoal", host: "127.0.0.2", relayPort: 8766 };
    setProfiles([{ ...SHELL_TEST_PROFILE, label: "Trabalho" }, other]);
    relay = installFakeRelay("fake reply", {
      integrations: {
        [RELAY]: { integrations: [jira([runtime({})])] },
        // What a profile without Jira can still report: a server that fails.
        "127.0.0.2:8766": { integrations: [jira([runtime({ status: "failed" })])] },
      },
    });
    const user = userEvent.setup();
    const rail = await openConversation(user);
    await within(rail).findByRole("button", { name: "Jira" });

    const switchTo = async (label: RegExp) => {
      await user.click(screen.getByRole("button", { name: en.shell.profiles.activeProfile }));
      await user.click(await within(document.body).findByRole("menuitem", { name: label }));
      await user.click(await screen.findByRole("button", { name: en.shell.sidebar.newConversation }));
    };
    // Every open tab draws its own dock; the inactive ones sit `invisible`.
    const activeRail = () => screen.getAllByTestId("dock-rail").find((element) => !element.closest(".invisible"))!;

    await switchTo(/Pessoal/);
    await waitFor(() => expect(relay.sockets.some((socket) => socket.url.includes("127.0.0.2:8766/integrations/watch"))).toBe(true));
    await waitFor(() => expect(activeRail().querySelector("[data-integration]")).toBeNull());
    expect(activeRail().querySelector("[data-rail-badge]")).toBeNull();

    await switchTo(/Trabalho/);
    await waitFor(() => expect(within(activeRail()).getByRole("button", { name: "Jira" })).toBeInTheDocument());
  }, 30_000);

  it("shows nothing, and no error, on a relay without integrations", async () => {
    start("legacy");
    const user = userEvent.setup();
    const rail = await openConversation(user);

    await waitFor(() => expect(relay.sockets.some((socket) => new URL(socket.url).pathname === "/integrations/watch")).toBe(true));
    expect(rail.querySelector("[data-integration]")).toBeNull();
    // The + has nothing to offer: no menu opens.
    await user.click(within(rail).getByRole("button", { name: en.panels.addView }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Recognized as old once, never redialed.
    expect(relay.sockets.filter((socket) => new URL(socket.url).pathname === "/integrations/watch")).toHaveLength(1);
  });

  it("adds Jira from the + when no agent has it", async () => {
    start({ integrations: [] });
    const user = userEvent.setup();
    const rail = await openConversation(user);

    await user.click(within(rail).getByRole("button", { name: en.panels.addView }));
    await user.click(await screen.findByRole("menuitem", { name: "Jira" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(en.integrations.add.title.replace("{name}", "Jira"))).toBeInTheDocument();
    // Both agents, picked by default (the relay's host info is not scripted).
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    await user.click(within(dialog).getByRole("checkbox", { name: en.chat.composer.agentNames.codex }));
    await user.click(within(dialog).getByRole("button", { name: en.integrations.add.submit }));

    // The connect card takes the dialog's place, to follow the sign-ins.
    await screen.findByTestId("connect-card");
    expect(screen.queryByText(en.integrations.add.title.replace("{name}", "Jira"))).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const sent = relay.sent.filter((entry) => entry.message.type === "integration_add");
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0].url).pathname).toBe("/integrations/watch");
    expect(sent[0].message).toEqual({ type: "integration_add", id: "jira", provider: "jira", runtimes: ["claude"] });

    // Once the relay reports it, the + offers it no more.
    relay.emitIntegrations(RELAY, [jira([runtime({ status: "needs_auth" })])]);
    await within(rail).findByRole("button", { name: jiraLabel(1) });
    await user.click(within(rail).getByRole("button", { name: en.panels.addView }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
