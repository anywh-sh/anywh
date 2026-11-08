// The connect card's "Add": pending from the click on, one `integration_add`
// however many clicks, the relay's answer leading straight into the sign-in
// it queued, and a failure or silence leaving "Try again".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ADD_TIMEOUT_MS, ConnectCard } from "./ConnectCard";
import { IntegrationsContext, type IntegrationsState } from "@/hooks/relay/useIntegrations";
import { addResultKey, EMPTY_PROFILE_INTEGRATIONS, type ProfileIntegrations } from "@/lib/integrations/derive";
import type { IntegrationState, IntegrationsClientMessage, McpAuthFlow } from "@/lib/integrations/model";
import type { Profile } from "@/lib/profiles/profiles";
import { en } from "@/i18n/en";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/relay/filesClient", () => ({ getHostInfo: vi.fn(() => Promise.resolve({ agents: [{ id: "claude" }] })) }));

const profile = { id: "p1", label: "Personal", host: "127.0.0.1", relayPort: 8765 } as unknown as Profile;
const copy = en.integrations.connect;

const jira = (overrides: Partial<IntegrationState> = {}): IntegrationState => ({ id: "jira", provider: "jira", runtimes: [], prefs: { project: null }, queries: [], ...overrides });

let sent: IntegrationsClientMessage[] = [];
let setEntry: (update: (entry: ProfileIntegrations) => ProfileIntegrations) => void = () => {};

function Harness() {
  const [entry, set] = useState<ProfileIntegrations>({ ...EMPTY_PROFILE_INTEGRATIONS, connection: "live", integrations: [jira()] });
  setEntry = (update) => set(update);
  const value: IntegrationsState = {
    byProfile: { [profile.id]: entry },
    send: (_profileId, message) => {
      sent.push(message);
      return true;
    },
  };
  return (
    <IntegrationsContext.Provider value={value}>
      <ConnectCard profile={profile} integrationId="jira" onOpenChange={() => {}} />
    </IntegrationsContext.Provider>
  );
}

async function renderCard() {
  render(<Harness />);
  // The machine's agents come in.
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId("connect-status-claude")).toHaveTextContent(copy.state.missing.replace("{name}", "Jira"));
}

const adds = () => sent.filter((message) => message.type === "integration_add");
const status = () => screen.getByTestId("connect-status-claude");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sent = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConnectCard: Add", () => {
  it("is pending from the click on and sends one integration_add however many clicks", async () => {
    await renderCard();
    const button = screen.getByRole("button", { name: copy.add });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(status()).toHaveTextContent(copy.adding);
    expect(screen.queryByRole("button", { name: copy.add })).toBeNull();
    expect(adds()).toEqual([{ type: "integration_add", id: "jira", provider: "jira", runtimes: ["claude"] }]);
  });

  it("goes from adding straight into the sign-in the relay queued, with no second click and no mcp_auth_start", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: copy.add }));
    const flow: McpAuthFlow = { flowId: "f1", runtimeId: "claude", serverName: "atlassian", phase: "awaiting_user", mode: "deeplink", authUrl: "https://auth.example/authorize?state=s", state: "s" };
    act(() =>
      setEntry((entry) => ({
        ...entry,
        integrations: [jira({ runtimes: [{ runtimeId: "claude", serverName: "atlassian", scope: "user", status: "needs_auth", authMode: "oauth", alternatives: 0 }] })],
        authFlows: { f1: flow },
        addResults: { [addResultKey("jira", "claude")]: { ok: true, serverName: "atlassian", at: Date.now() } },
      })),
    );
    expect(status()).toHaveTextContent(copy.awaiting);
    expect(sent.filter((message) => message.type === "mcp_auth_start")).toEqual([]);
    expect(adds()).toHaveLength(1);
  });

  it("shows the relay's failure with Try again, which adds again", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: copy.add }));
    act(() => setEntry((entry) => ({ ...entry, addResults: { [addResultKey("jira", "claude")]: { error: "permission denied", at: Date.now() } } })));
    expect(status()).toHaveTextContent(copy.addFailed);
    expect(screen.getByTestId("connect-add-error")).toHaveTextContent(copy.addErrors.generic);
    fireEvent.click(screen.getByRole("button", { name: copy.retry }));
    expect(adds()).toHaveLength(2);
    expect(status()).toHaveTextContent(copy.adding);
  });

  it("an add nobody answers ends in a timeout with Try again, never back to Add on its own", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: copy.add }));
    act(() => {
      vi.advanceTimersByTime(ADD_TIMEOUT_MS - 1);
    });
    expect(status()).toHaveTextContent(copy.adding);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(status()).toHaveTextContent(copy.addFailed);
    expect(screen.getByTestId("connect-add-error")).toHaveTextContent(copy.addErrors.timeout);
    expect(screen.getByRole("button", { name: copy.retry })).toBeInTheDocument();
  });

  it("shows adding while the relay says another device is adding", async () => {
    await renderCard();
    act(() => setEntry((entry) => ({ ...entry, integrations: [jira({ adding: ["claude"] })] })));
    expect(status()).toHaveTextContent(copy.adding);
    expect(screen.queryByRole("button", { name: copy.add })).toBeNull();
  });
});
