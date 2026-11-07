import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeRelay, type FakeIntegrations, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { seedShellProfile } from "./helpers/seedProfile";
import { en } from "@/i18n/en";
import { __resetMcpOAuthForTests, routeMcpOAuthCallback } from "@/lib/integrations/oauthDeepLink";
import type { IntegrationRuntime, IntegrationState, McpAuthFlow } from "@/lib/integrations/model";

// Same Tauri shims as integrationsRail.test.tsx; the opener is a no-op that
// records what the card asked to open.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => [] }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => {
    opened.push(url);
    return Promise.resolve();
  },
}));

const RELAY = "127.0.0.1:8765";
const SLOW = { timeout: 10_000 };
const copy = en.integrations.connect;

function runtime(patch: Partial<IntegrationRuntime>): IntegrationRuntime {
  return { runtimeId: "claude", serverName: "atlassian", scope: "user", status: "connected", authMode: "oauth", alternatives: 0, ...patch };
}

function jira(runtimes: IntegrationRuntime[]): IntegrationState {
  return { id: "jira", provider: "jira", runtimes, site: { id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" }, prefs: { project: null }, queries: [] };
}

function flow(patch: Partial<McpAuthFlow> & Pick<McpAuthFlow, "flowId" | "phase">): { type: "mcp_auth_flow" } & McpAuthFlow {
  return { type: "mcp_auth_flow", runtimeId: "claude", serverName: "atlassian", mode: "deeplink", ...patch };
}

let relay: FakeRelay;

function start(integrations: FakeIntegrations): void {
  relay = installFakeRelay("fake reply", { integrations: { [RELAY]: integrations }, agentId: "claude" });
}

const sentOfType = (type: string) => relay.sent.filter((entry) => entry.message.type === type).map((entry) => entry.message);

beforeEach(() => {
  localStorage.clear();
  opened.length = 0;
  __resetMcpOAuthForTests();
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

/** Rail button → pane → its notice → the card. */
async function openCardFromPane(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const rail = await openConversation(user);
  await user.click(await within(rail).findByRole("button", { name: /^Jira ·/ }));
  const notice = await screen.findByTestId("integration-connect-notice");
  await user.click(within(notice).getByRole("button", { name: en.integrations.panel.connect }));
  return screen.findByTestId("connect-card");
}

const status = (card: HTMLElement, runtimeId: string) => within(card).getByTestId(`connect-status-${runtimeId}`);

describe("connecting an integration", () => {
  it("signs two agents in one after the other, the browser coming back through the app's link", async () => {
    start({ integrations: [jira([runtime({ status: "needs_auth" }), runtime({ runtimeId: "codex", status: "needs_auth" })])] });
    const user = userEvent.setup();
    const card = await openCardFromPane(user);

    expect(within(card).getByText(copy.title.replace("{name}", "Jira"))).toBeInTheDocument();
    expect(within(card).getByTestId("connect-progress")).toHaveTextContent("0 of 2");
    expect(status(card, "claude")).toHaveTextContent(copy.state.needsAuth);
    expect(status(card, "codex")).toHaveTextContent(copy.state.needsAuth);

    await user.click(within(card).getByRole("button", { name: copy.connectAll }));
    expect(sentOfType("mcp_auth_start")).toEqual([
      {
        type: "mcp_auth_start",
        targets: [
          { runtimeId: "claude", serverName: "atlassian" },
          { runtimeId: "codex", serverName: "atlassian" },
        ],
      },
    ]);

    // The relay runs the queue: Claude first, Codex waits.
    const authUrl = "https://auth.example/authorize?state=s-claude";
    act(() => {
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "awaiting_user", authUrl, state: "s-claude" }));
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f2", runtimeId: "codex", phase: "queued" }));
    });
    await waitFor(() => expect(status(card, "claude")).toHaveTextContent(copy.awaiting));
    expect(status(card, "codex")).toHaveTextContent(copy.queued);
    // The browser is opened once for the flow.
    await waitFor(() => expect(opened).toEqual([authUrl]));

    // The OS hands the app the callback; it goes to the relay that waits.
    act(() => {
      expect(routeMcpOAuthCallback("anywh://mcp-oauth/callback?code=abc&state=s-claude")).toBe(true);
    });
    await waitFor(() =>
      expect(sentOfType("mcp_auth_complete")).toEqual([{ type: "mcp_auth_complete", flowId: "f1", callbackUrl: "anywh://mcp-oauth/callback?code=abc&state=s-claude" }]),
    );

    act(() => {
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "done", state: "s-claude" }));
      relay.emitIntegrations(RELAY, [jira([runtime({}), runtime({ runtimeId: "codex", status: "needs_auth" })])]);
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f2", runtimeId: "codex", phase: "awaiting_user", authUrl: "https://auth.example/codex?state=s-codex", state: "s-codex" }));
    });
    await waitFor(() => expect(status(card, "claude")).toHaveTextContent(copy.connectedTo.replace("{host}", "acme.atlassian.net")));
    expect(within(card).getByTestId("connect-progress")).toHaveTextContent("1 of 2");
    expect(status(card, "codex")).toHaveTextContent(copy.awaiting);
  });

  it("moves a sign-in to another device: copy the link, paste where the browser ended, checked first", async () => {
    start({ integrations: [jira([runtime({ status: "needs_auth" })])] });
    const user = userEvent.setup();
    const card = await openCardFromPane(user);

    await user.click(within(card).getByRole("button", { name: copy.connect }));
    act(() => relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "awaiting_user", authUrl: "https://auth.example/a?state=s1", state: "s1" })));
    await user.click(await within(card).findByRole("button", { name: copy.anotherDevice }));

    expect(sentOfType("mcp_auth_cancel")).toEqual([{ type: "mcp_auth_cancel", flowId: "f1" }]);
    const starts = sentOfType("mcp_auth_start");
    expect(starts[starts.length - 1]).toEqual({ type: "mcp_auth_start", targets: [{ runtimeId: "claude", serverName: "atlassian" }], mode: "localhost" });

    act(() => {
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "cancelled", state: "s1" }));
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f2", phase: "awaiting_user", mode: "localhost", authUrl: "https://auth.example/b?state=s2", state: "s2" }));
    });
    const field = await within(card).findByLabelText(copy.pasteLabel);
    expect(within(card).getByRole("button", { name: copy.copyLink })).toBeInTheDocument();
    // A localhost sign-in moved elsewhere does not open the browser here.
    expect(opened).toEqual(["https://auth.example/a?state=s1"]);

    await user.type(field, "not an address");
    await user.click(within(card).getByRole("button", { name: copy.finish }));
    expect(within(card).getByRole("alert")).toHaveTextContent(copy.pasteErrors.not_url);

    await user.clear(field);
    await user.type(field, "http://localhost:4567/callback?code=c&state=other");
    await user.click(within(card).getByRole("button", { name: copy.finish }));
    expect(within(card).getByRole("alert")).toHaveTextContent(copy.pasteErrors.state_mismatch);

    await user.clear(field);
    await user.type(field, "http://localhost:4567/callback?state=s2");
    await user.click(within(card).getByRole("button", { name: copy.finish }));
    expect(within(card).getByRole("alert")).toHaveTextContent(copy.pasteErrors.missing_code);
    expect(sentOfType("mcp_auth_complete")).toEqual([]);

    await user.clear(field);
    await user.type(field, "http://localhost:4567/callback?code=c&state=s2");
    await user.click(within(card).getByRole("button", { name: copy.finish }));
    expect(sentOfType("mcp_auth_complete")).toEqual([{ type: "mcp_auth_complete", flowId: "f2", callbackUrl: "http://localhost:4567/callback?code=c&state=s2" }]);
  });

  it("asks the relay to look again for a claude.ai connector, on the button and on coming back", async () => {
    start({ integrations: [jira([runtime({ scope: "claudeai", authMode: "claudeai", status: "needs_auth", serverName: "claude.ai Atlassian" })])] });
    const user = userEvent.setup();
    const card = await openCardFromPane(user);

    await user.click(within(card).getByRole("button", { name: copy.connect }));
    const authUrl = "https://claude.ai/api/organizations/org/mcp/start-auth/x";
    act(() => relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "awaiting_user", mode: "claudeai", serverName: "claude.ai Atlassian", authUrl })));
    await waitFor(() => expect(status(card, "claude")).toHaveTextContent(copy.claudeai));
    await waitFor(() => expect(opened).toEqual([authUrl]));

    await user.click(within(card).getByRole("button", { name: copy.recheck }));
    expect(sentOfType("mcp_auth_recheck")).toEqual([{ type: "mcp_auth_recheck", flowId: "f1" }]);
    fireEvent.focus(window);
    expect(sentOfType("mcp_auth_recheck")).toHaveLength(2);

    act(() => relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "failed", mode: "claudeai", serverName: "claude.ai Atlassian", error: "not authorized" })));
    await waitFor(() => expect(status(card, "claude")).toHaveTextContent(copy.failed));
    await user.click(within(card).getByRole("button", { name: copy.retry }));
    expect(sentOfType("mcp_auth_start")).toHaveLength(2);
  });

  it("offers to connect from a failed call in the chat and above the composer", async () => {
    start({ integrations: [jira([runtime({ status: "connected" })])] });
    const user = userEvent.setup();
    await openConversation(user);
    expect(screen.queryByTestId("mcp-needs-auth")).toBeNull();

    // The agent's call fails because its server wants a new sign-in.
    act(() => {
      relay.emit({ type: "agent_event", event: { type: "tool_started", toolUseId: "t1", name: "mcp__atlassian__searchJiraIssuesUsingJql", kind: "other", input: {}, subject: { kind: "mcp", server: "atlassian", tool: "searchJiraIssuesUsingJql" } } });
      relay.emit({ type: "agent_event", event: { type: "tool_ended", toolUseId: "t1", content: "session expired", isError: true, mcpFailure: { server: "atlassian", reason: "auth" } } });
      relay.emit({ type: "mcp_state", runtimeId: "claude", servers: [{ name: "atlassian", status: "needs_auth", integrationId: "jira", canLogin: true }] });
    });
    const sentence = en.integrations.chat.agentNotConnected.replace("{agent}", "Claude Code").replace("{name}", "Jira");
    const notices = await screen.findAllByText(sentence);
    expect(notices.length).toBe(2);

    const chip = await screen.findByTestId("mcp-needs-auth");
    await user.click(within(chip).getByRole("button", { name: en.integrations.chat.connect }));
    const card = await screen.findByTestId("connect-card");
    expect(within(card).getByText(copy.title.replace("{name}", "Jira"))).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("connect-card")).toBeNull());

    // The failed call's own notice opens the same card.
    const inline = notices.find((element) => !chip.contains(element))!.closest("[data-mcp-connect]") as HTMLElement;
    await user.click(within(inline).getByRole("button", { name: en.integrations.chat.connect }));
    await screen.findByTestId("connect-card");

    // Once connected, the chip goes away.
    act(() => relay.emit({ type: "mcp_state", runtimeId: "claude", servers: [{ name: "atlassian", status: "connected", integrationId: "jira", canLogin: true }] }));
    await waitFor(() => expect(screen.queryByTestId("mcp-needs-auth")).toBeNull());
  });

  it("follows the sign-ins of an integration added from the +", async () => {
    start({ integrations: [] });
    const user = userEvent.setup();
    const rail = await openConversation(user);

    await user.click(within(rail).getByRole("button", { name: en.panels.addView }));
    await user.click(await screen.findByRole("menuitem", { name: "Jira" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: en.integrations.add.submit }));

    const card = await screen.findByTestId("connect-card");
    act(() => {
      relay.emitIntegrations(RELAY, [jira([runtime({ status: "needs_auth" })])]);
      relay.emitOnIntegrations(RELAY, flow({ flowId: "f1", phase: "awaiting_user", authUrl: "https://auth.example/a?state=s1", state: "s1" }));
    });
    await waitFor(() => expect(status(card, "claude")).toHaveTextContent(copy.awaiting));
  });
});
