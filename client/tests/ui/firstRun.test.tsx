import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProfiles, setProfiles, type Profile } from "@/lib/profiles/profiles";
import { clearProfileRevoked, markProfileRevoked } from "@/lib/profiles/profileRevocation";
import { __resetProfileSetupForTests } from "@/lib/profiles/profileSetup";
import { __resetFirstRunForTests } from "@/lib/profiles/firstRun";
import { enqueueProfileSetup } from "@/lib/profiles/profileSetup";
import { PENDING_AGENTS_STORAGE_KEY } from "@/lib/install/pendingAgents";
import { installFakeRelay, type FakeAgent, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";

/**
 * Drives the real `App` from "this device has no profile" to the shell, by
 * click and keystroke, through the paths a device with no in-app install
 * (this tier runs outside Tauri, like the browser and iOS) is offered:
 * another machine, by code or by address, then its agents. Same seams as
 * profileSetup.test.tsx: the tailnet layers are mocked at their edge,
 * pairing discovery and the relay's own HTTP run through the fake fetch
 * router below, everything in between is real — the gate in App.tsx,
 * `firstRun.ts`, the setup queue, the inline progress, the agents step and
 * the hand-over into a shell that has exactly one profile.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

const {
  claimTailnetBundleMock,
  acquireTailnetSidecarMock,
  releaseTailnetSidecarMock,
  peekTailnetSidecarMock,
  resolveTailnetTargetMock,
  fetchConnectGrantMock,
} = vi.hoisted(() => ({
  claimTailnetBundleMock: vi.fn(),
  acquireTailnetSidecarMock: vi.fn(),
  releaseTailnetSidecarMock: vi.fn(),
  peekTailnetSidecarMock: vi.fn(),
  resolveTailnetTargetMock: vi.fn(),
  fetchConnectGrantMock: vi.fn(),
}));

vi.mock("@/lib/profiles/tailnetClaim", () => ({ claimTailnetBundle: claimTailnetBundleMock }));
vi.mock("@/lib/profiles/tailnetSidecar", () => ({
  acquireTailnetSidecar: acquireTailnetSidecarMock,
  releaseTailnetSidecar: releaseTailnetSidecarMock,
  peekTailnetSidecar: peekTailnetSidecarMock,
}));
vi.mock("@/lib/profiles/tailnetBroker", () => ({
  resolveTailnetTarget: resolveTailnetTargetMock,
  fetchConnectGrant: fetchConnectGrantMock,
}));

const SIDECAR_ENDPOINT = { host: "127.0.0.1", port: 9999 };
/** The machine path 01 dials — a LAN address, like a real one would be. */
const MACHINE = { host: "192.168.0.50", port: 8765 };

function fakeJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let relay: FakeRelay;

const other = en.firstRun.other;
const agents = en.firstRun.agents;
const CLAUDE: FakeAgent = {
  id: "claude",
  installed: true,
  version: "2.1.3",
  loggedIn: true,
  loginCommand: "claude auth login",
  installUrl: "https://claude.example/setup",
};

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetFirstRunForTests();
  relay = installFakeRelay("fake relay reply", { control: { agents: [CLAUDE] } });
  // The fake relay answers the control routes (agents, the profile PATCH);
  // the router below adds pairing discovery and `/sessions` per machine.
  const relayFetch = globalThis.fetch;

  claimTailnetBundleMock.mockReset().mockResolvedValue({
    nodeId: "node-1",
    controlUrl: "https://ctrl.test",
    authKey: "key",
    brokerUrl: "https://broker.test/w1",
  });
  resolveTailnetTargetMock.mockReset().mockResolvedValue({ target: "100.64.0.1:8443", token: "connect-token" });
  acquireTailnetSidecarMock.mockReset().mockResolvedValue(SIDECAR_ENDPOINT);
  releaseTailnetSidecarMock.mockReset();
  peekTailnetSidecarMock.mockReset().mockReturnValue(Promise.resolve(SIDECAR_ENDPOINT));
  fetchConnectGrantMock.mockReset().mockResolvedValue({ endpoint: SIDECAR_ENDPOINT, token: "fresh-token" });

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/.well-known/anywh-pairing")) return Promise.resolve(fakeJsonResponse({ claimUrl: "https://broker.test/claim" }));
      if (url.endsWith("/sessions")) return Promise.resolve(fakeJsonResponse({ sessions: [{ id: "s1", title: "Hello", lastActiveAt: null }] }));
      return relayFetch(input, init);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
  clearProfileRevoked("only");
});

async function expectShellWithOneProfile(label: string): Promise<void> {
  await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent(label));
  expect(screen.queryByText(other.title)).not.toBeInTheDocument();
  expect(getProfiles()).toHaveLength(1);
  // The hand-over wrote the active-profile key before the shell mounted —
  // otherwise the shell's initial read would have landed on `profiles[0]`
  // only by coincidence.
  expect(localStorage.getItem("anywh:last-profile")).toBe(getProfiles()[0].id);
  expect(localStorage.getItem(PENDING_AGENTS_STORAGE_KEY)).toBeNull();
}

async function connectByAddress(user: ReturnType<typeof userEvent.setup>, host: string, port?: number): Promise<void> {
  await user.click(await screen.findByRole("tab", { name: other.modes.address }));
  await user.type(screen.getByRole("textbox", { name: other.address.host }), host);
  if (port !== undefined) {
    const field = screen.getByRole("textbox", { name: other.address.port });
    await user.clear(field);
    await user.type(field, String(port));
  }
  await user.click(screen.getByRole("button", { name: other.connect }));
}

/** The agents step: the relay found Claude; starting with it saves it as
 * the profile's default and hands over to the shell. */
async function startWithClaude(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const start = await screen.findByRole("button", { name: agents.startWith.replace("{agent}", en.chat.composer.agentNames.claude) });
  await user.click(start);
}

describe("first run", () => {
  it("takes over the window, on another machine with nowhere to go back to, where nothing can be installed", async () => {
    renderApp();

    await screen.findByRole("heading", { name: other.title });
    expect(screen.queryByRole("button", { name: en.firstRun.frame.back })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shell.sidebar.newConversation })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("connects by address, shows that machine's agents, and starts with the one picked", async () => {
    const user = userEvent.setup();
    renderApp();

    await connectByAddress(user, MACHINE.host, MACHINE.port);
    // Inline, then the agents of that machine — never a dialog on top.
    await screen.findByRole("heading", { name: agents.title });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(agents.scopeAt.replace("{host}", MACHINE.host))).toBeInTheDocument();
    expect(getProfiles()).toHaveLength(1);
    expect(localStorage.getItem(PENDING_AGENTS_STORAGE_KEY)).toBe(getProfiles()[0].id);

    await startWithClaude(user);
    await expectShellWithOneProfile(MACHINE.host);
    expect(relay.patches).toEqual([{ id: getProfiles()[0].id, body: { agentPreference: { mode: "fixed", fixedAgentId: "claude" } } }]);
  });

  it("pairs by code and lands in the shell on the new profile", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText(other.code.label), "ABCDEF-GHJKMNPQ@example.test");
    await user.click(screen.getByRole("button", { name: other.connect }));

    await startWithClaude(user);
    await expectShellWithOneProfile(getProfiles()[0].label);
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("a machine that doesn't answer stays on the first run, unverified, with try again", async () => {
    const user = userEvent.setup();
    let answering = false;
    const routed = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!answering && url.includes("10.0.0.99")) return Promise.reject(new Error("connection refused"));
      return routed!(input, init);
    });
    renderApp();

    await connectByAddress(user, "10.0.0.99");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(other.failed.verify);
    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].unverified).toBe(true);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();

    answering = true;
    await user.click(within(alert).getByRole("button", { name: other.retry }));
    await screen.findByRole("heading", { name: agents.title });
    expect(getProfiles()[0].unverified).toBeUndefined();
  });

  it("stays on the first run when a claim never lands, with nothing saved", async () => {
    claimTailnetBundleMock.mockRejectedValueOnce(new Error("code already used"));
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText(other.code.label), "ABCDEF-GHJKMNPQ@example.test");
    await user.click(screen.getByRole("button", { name: other.connect }));

    expect(await screen.findByRole("alert")).toHaveTextContent(other.failed.claim);
    expect(getProfiles()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("a link arriving on the first run shows its progress where the reader is", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: other.title });

    enqueueProfileSetup({ source: "params", params: { label: "Linked", host: MACHINE.host, port: String(MACHINE.port) } });
    await screen.findByRole("heading", { name: agents.title });
    await startWithClaude(user);
    await expectShellWithOneProfile("Linked");
  });

  it("a relaunch on the agents step comes back to it, not to the shell", async () => {
    setProfiles([{ id: "home", label: "Home", host: MACHINE.host, relayPort: MACHINE.port }]);
    localStorage.setItem(PENDING_AGENTS_STORAGE_KEY, "home");
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: agents.title });
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
    await startWithClaude(user);
    await expectShellWithOneProfile("Home");
  });

  it("removing the last profile is allowed, and puts the first run back on the window", async () => {
    // Used to be refused with "add another one first" — with an empty list
    // legitimate, the banner's remove goes through and the gate flips.
    const only: Profile = { id: "only", label: "Only", host: MACHINE.host, relayPort: MACHINE.port };
    setProfiles([only]);
    markProfileRevoked(only.id);
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: en.shell.profiles.activeProfile });

    await user.click(screen.getByRole("button", { name: en.shell.revoked.removeProfile }));
    // The confirmation says what removing the only profile means.
    await within(document.body).findByText(en.shell.revoked.lastProfile);
    await user.click(within(document.body).getByRole("button", { name: en.common.remove }));

    await screen.findByRole("heading", { name: other.title });
    expect(getProfiles()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("a sole unverified profile resumes its verification on launch and goes on to its agents", async () => {
    // The run after one that died between the claim and the verification:
    // the profile is saved, the list isn't empty, and the shell would open
    // on a machine that was never reached.
    setProfiles([{ id: "left", label: "Left over", host: MACHINE.host, relayPort: MACHINE.port, unverified: true }]);
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { name: agents.title });
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
    await startWithClaude(user);
    await expectShellWithOneProfile("Left over");
    expect(getProfiles()[0].unverified).toBeUndefined();
  });

  it("with other profiles around, an unverified one is badged in the shell and finishes from the switcher — no dialog on boot", async () => {
    setProfiles([
      { id: "home", label: "Home", host: "127.0.0.1", relayPort: 8765 },
      { id: "left", label: "Left over", host: MACHINE.host, relayPort: MACHINE.port, unverified: true },
    ]);
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("button", { name: en.shell.profiles.activeProfile });
    expect(screen.queryByText(en.shell.profiles.setup.connectingTitle)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.activeProfile }));
    expect(await within(document.body).findByText(en.shell.profiles.badgeUnverified)).toBeInTheDocument();
    await user.click(
      within(document.body).getByRole("menuitem", { name: en.shell.profiles.finishSetup.replace("{label}", "Left over") }),
    );

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Left over"));
    expect(getProfiles().find((p) => p.id === "left")?.unverified).toBeUndefined();
  });

  it("switches language from inside the first run", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(other.title);

    await user.click(screen.getByRole("button", { name: "en" }));
    await user.click(await within(document.body).findByRole("menuitemradio", { name: "Português (Brasil)" }));

    await screen.findByText(ptBr.firstRun.other.title);
    expect(screen.queryByText(other.title)).not.toBeInTheDocument();
  });

  it("the advanced options' terminal path ends by pointing the address form at 127.0.0.1:8765, and Back returns", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: other.advanced }));
    await screen.findByRole("heading", { name: en.firstRun.advanced.title });
    // The commands are the documented ones, not something generated here.
    expect(screen.getByText("curl -fsSL https://anywh.sh/install | sh")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.firstRun.frame.back }));
    await screen.findByRole("heading", { name: other.title });
    await user.click(screen.getByRole("button", { name: other.advanced }));

    await user.click(await screen.findByRole("button", { name: en.firstRun.advanced.terminal.done }));
    expect(await screen.findByRole("textbox", { name: other.address.host })).toHaveValue("127.0.0.1");
    expect(screen.getByRole("textbox", { name: other.address.port })).toHaveValue("8765");
  });
});
