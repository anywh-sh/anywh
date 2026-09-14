import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProfiles, setProfiles, type Profile } from "@/lib/profiles";
import { clearProfileRevoked, markProfileRevoked } from "@/lib/profileRevocation";
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
  clearProfileRevoked("only");
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

    // Nothing left for it to do that "Continue" doesn't already do — the
    // button that would suggest otherwise isn't shown at all here.
    expect(screen.queryByRole("button", { name: en.shell.profiles.setup.later })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");

    await expectShellWithOneProfile(MACHINE.host);
  });

  it("won't let Escape close the dialog while a request is still connecting", async () => {
    const user = userEvent.setup();
    let resolveAcquire!: (endpoint: typeof SIDECAR_ENDPOINT) => void;
    acquireTailnetSidecarMock.mockImplementationOnce(() => new Promise((resolve) => (resolveAcquire = resolve)));
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.codeTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.code.codeLabel), "ABCDEF-GHJKMNPQ@example.test");
    await user.click(screen.getByRole("button", { name: en.firstRun.code.submit }));

    await screen.findByText(en.shell.profiles.setup.connectingTitle);
    await user.keyboard("{Escape}");
    // Still up — a stray Escape can't lose the reader's place mid-flight.
    expect(screen.getByText(en.shell.profiles.setup.connectingTitle)).toBeInTheDocument();

    resolveAcquire(SIDECAR_ENDPOINT);
    await screen.findByText(en.shell.profiles.setup.connectedTitle);
  });

  it("'Leave it for later' while connecting doesn't reopen the dialog once the connection settles", async () => {
    const user = userEvent.setup();
    let resolveAcquire!: (endpoint: typeof SIDECAR_ENDPOINT) => void;
    acquireTailnetSidecarMock.mockImplementationOnce(() => new Promise((resolve) => (resolveAcquire = resolve)));
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.codeTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.code.codeLabel), "ABCDEF-GHJKMNPQ@example.test");
    await user.click(screen.getByRole("button", { name: en.firstRun.code.submit }));

    await screen.findByText(en.shell.profiles.setup.connectingTitle);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));

    await screen.findByText(en.firstRun.code.title);
    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].unverified).toBe(true);

    // The connect step the reader walked away from finishes on its own —
    // the dialog must not pop back open to announce it.
    resolveAcquire(SIDECAR_ENDPOINT);
    await vi.waitFor(() => expect(getProfiles()[0].unverified).toBeUndefined());
    expect(screen.queryByText(en.shell.profiles.setup.connectedTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("retrying the same address after dismissing mid-verify works once the orphaned attempt actually finishes", async () => {
    const user = userEvent.setup();
    let resolveFetch!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => (resolveFetch = resolve)));
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.connectTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.connect.hostLabel), "127.0.0.1");
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));

    await screen.findByText(en.shell.profiles.setup.verifying);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));
    await screen.findByText(en.firstRun.connect.title);

    // The orphaned verify is still running — the same address is still
    // reserved, same as before this fix, and that part is correct: it's
    // one in-flight attempt, not two racing each other.
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));
    await screen.findByText(en.firstRun.connect.alreadyQueued);

    resolveFetch(fakeJsonResponse({ sessions: [] }));
    await vi.waitFor(() => expect(getProfiles()[0]?.unverified).toBeUndefined());

    // Now that it has actually finished, the address is free again — this
    // used to stay stuck on "already being set up" forever, because
    // nothing ever released the reservation for a dismissed-mid-flight
    // request once it settled.
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));
    await screen.findByText(en.shell.profiles.setup.connectedTitle);
  });

  it("dismissing a failed verify leaves the profile unverified on the wizard, instead of handing over a broken shell", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.connectTitle) }));
    await user.type(await screen.findByLabelText(en.firstRun.connect.hostLabel), "10.0.0.99");
    vi.mocked(fetch).mockImplementationOnce(() => Promise.reject(new Error("connection refused")));
    await user.click(screen.getByRole("button", { name: en.firstRun.connect.submit }));

    await screen.findByText(en.shell.profiles.setup.verifyFailedTitle);
    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].unverified).toBe(true);

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));

    await screen.findByText(en.firstRun.connect.title);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
    expect(getProfiles()).toHaveLength(1);
    expect(getProfiles()[0].unverified).toBe(true);
    expect(localStorage.getItem("anywh:last-profile")).toBeNull();
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

    await screen.findByRole("heading", { name: en.firstRun.home.title });
    expect(getProfiles()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
  });

  it("a sole unverified profile resumes its verification on launch and hands over once it passes", async () => {
    // The run after one that died between the claim and the verification:
    // the profile is saved, the list isn't empty, and the shell would open
    // on a machine that was never reached.
    setProfiles([{ id: "left", label: "Left over", host: MACHINE.host, relayPort: MACHINE.port, unverified: true }]);
    const user = userEvent.setup();
    renderApp();

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

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
    await screen.findByText(en.firstRun.home.title);

    await user.click(screen.getByRole("button", { name: "en" }));
    await user.click(await within(document.body).findByRole("menuitemradio", { name: "Português (Brasil)" }));

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
