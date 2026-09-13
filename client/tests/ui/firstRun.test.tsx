import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProfiles, setProfiles } from "@/lib/profiles";
import { __resetProfileSetupForTests } from "@/lib/profileSetup";
import { __resetFirstRunForTests } from "@/lib/firstRun";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";
import { ptBr } from "@/i18n/pt-br";

/**
 * Drives the real `App` from "this device has no profile" to the shell, by
 * click and keystroke, through each path the first-run screen offers. Same
 * tier and same seams as profileSetup.test.tsx: the tailnet layers are
 * mocked at their edge, pairing discovery and the relay's own HTTP run
 * through the fake fetch router below, everything in between is real —
 * the gate in App.tsx, `firstRun.ts`, the setup queue, the dialog, and the
 * hand-over into a shell that has exactly one profile.
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

vi.mock("@/lib/tailnetClaim", () => ({ claimTailnetBundle: claimTailnetBundleMock }));
vi.mock("@/lib/tailnetSidecar", () => ({
  acquireTailnetSidecar: acquireTailnetSidecarMock,
  releaseTailnetSidecar: releaseTailnetSidecarMock,
  peekTailnetSidecar: peekTailnetSidecarMock,
}));
vi.mock("@/lib/tailnetBroker", () => ({
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

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetFirstRunForTests();
  relay = installFakeRelay();

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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/anywh-pairing")) return fakeJsonResponse({ claimUrl: "https://broker.test/claim" });
      if (url.includes(`${SIDECAR_ENDPOINT.host}:${String(SIDECAR_ENDPOINT.port)}/sessions`)) return fakeJsonResponse({ sessions: [] });
      if (url.includes(`${MACHINE.host}:${String(MACHINE.port)}/sessions`)) {
        return fakeJsonResponse({ sessions: [{ id: "s1", title: "Hello", lastActiveAt: null }] });
      }
      return fakeJsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function expectShellWithOneProfile(label: string): Promise<void> {
  await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent(label));
  expect(screen.queryByText(en.firstRun.home.title)).not.toBeInTheDocument();
  expect(getProfiles()).toHaveLength(1);
  // The hand-over wrote the active-profile key before the shell mounted —
  // otherwise the shell's initial read would have landed on `profiles[0]`
  // only by coincidence.
  expect(localStorage.getItem("anywh:last-profile")).toBe(getProfiles()[0].id);
}

describe("first run", () => {
  it("takes over the window when this device has no profile", async () => {
    renderApp();

    await screen.findByRole("heading", { name: en.firstRun.home.title });
    expect(screen.queryByRole("button", { name: en.shell.sidebar.newConversation })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("connects to an existing machine by address and hands over to a shell with exactly that one profile", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.connectTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.connect.hostLabel), MACHINE.host);
    const port = screen.getByLabelText(en.firstRun.connect.portLabel);
    await user.clear(port);
    await user.type(port, String(MACHINE.port));
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    // The profile is already saved by now — and the first run is still the
    // screen underneath the dialog, not the shell. Plain text, not getByRole:
    // the open dialog marks the rest of the page aria-hidden.
    expect(getProfiles()).toHaveLength(1);
    expect(screen.getByText(en.firstRun.connect.title)).toBeInTheDocument();
    expect(screen.getByText(en.shell.profiles.setup.ready.replace("{count}", "1"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await expectShellWithOneProfile(MACHINE.host);
  });

  it("pairs by code from the first run and lands in the shell on the new profile", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.codeTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.code.codeLabel), "ABCDEF-GHJKMNPQ@example.test");
    await user.type(screen.getByLabelText(en.firstRun.code.nameLabel), "New machine");
    await user.click(screen.getByRole("button", { name: en.firstRun.code.submit }));

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await expectShellWithOneProfile("New machine");
    expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1);
  });

  it("dismissing the ready screen still hands over — there is no 'later' before the shell exists", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.connectTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.connect.hostLabel), MACHINE.host);
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));
    await screen.findByText(en.shell.profiles.setup.connectedTitle);

    await user.keyboard("{Escape}");

    await expectShellWithOneProfile(MACHINE.host);
  });

  it("stays on the first run when a claim never lands, with nothing saved", async () => {
    claimTailnetBundleMock.mockRejectedValueOnce(new Error("code already used"));
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.codeTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.code.codeLabel), "ABCDEF-GHJKMNPQ@example.test");
    await user.click(screen.getByRole("button", { name: en.firstRun.code.submit }));

    await screen.findByText(en.shell.profiles.setup.claimFailedTitle);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));

    await screen.findByText(en.firstRun.code.title);
    expect(getProfiles()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("switches language from inside the first run", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(en.firstRun.home.title);

    await user.click(screen.getByRole("combobox"));
    await user.click(await within(document.body).findByRole("option", { name: "Português (Brasil)" }));

    await screen.findByText(ptBr.firstRun.home.title);
    expect(screen.queryByText(en.firstRun.home.title)).not.toBeInTheDocument();
  });

  it("the terminal path ends by pointing path 01 at this machine", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: en.firstRun.home.terminalLink }));
    await screen.findByText(en.firstRun.manual.title);
    // The commands are the documented ones, not something generated here.
    expect(screen.getByText("curl -fsSL https://anywh.sh/install | sh")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.firstRun.manual.done }));

    expect(await screen.findByLabelText(en.firstRun.connect.hostLabel)).toHaveValue("127.0.0.1");
  });
});
