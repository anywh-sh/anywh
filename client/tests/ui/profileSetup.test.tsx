import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setProfiles } from "@/lib/profiles/profiles";
import { enqueueProfileSetup, __resetProfileSetupForTests } from "@/lib/profiles/profileSetup";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * Drives the real `App` through the pairing-code path (`ProfileSwitcher` ->
 * `AddRemoteMachineDialog` -> `profileSetup.ts`'s queue -> `ProfileSetupDialog`)
 * by click/type, the same tier/reasoning as sendMessage.test.tsx and
 * revokedBackgroundProfile.test.tsx.
 *
 * `tailnetClaim`/`tailnetSidecar`/`tailnetBroker` are mocked directly rather
 * than flipping `inTauri()` true, same call as revokedBackgroundProfile.test.tsx
 * makes: that would also turn on every other Tauri-gated hook mounted by
 * `<App/>` (window controls, notifications, `@tauri-apps/plugin-os`, the
 * deep-link listener itself), none of which this scenario is about.
 * `pairingCode.ts`'s own discovery fetch runs for real, routed through the
 * fake HTTP layer below, alongside `fetchSessions`/`fetchControlProfiles`.
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

function fakeJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  __resetProfileSetupForTests();
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

  // installFakeRelay's own fetch stub rejects everything by design (the
  // fake-relay tier's WS-only scope) — replaced here with a router covering
  // this flow's two real HTTP calls: pairing discovery, and the
  // sidecar-fronted /sessions + /control/profiles once verifyStep runs.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/anywh-pairing")) return fakeJsonResponse({ claimUrl: "https://broker.test/claim" });
      if (url.includes(`${SIDECAR_ENDPOINT.host}:${String(SIDECAR_ENDPOINT.port)}/sessions`)) return fakeJsonResponse({ sessions: [] });
      return fakeJsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

async function pairByCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.shell.profiles.activeProfile }));
  await user.click(await screen.findByRole("menuitem", { name: en.shell.profiles.addRemoteMachine }));
  await user.type(await screen.findByLabelText(en.shell.profiles.pair.nameLabel), "New machine");
  await user.type(await screen.findByLabelText(en.shell.profiles.pair.codeLabel), "ABCDEF-GHJKMNPQ@example.test");
  await user.click(await screen.findByRole("button", { name: en.shell.profiles.pair.submit }));
}

describe("profile setup", () => {
  it("pairs by code through to the ready screen without switching profile, and switches only after Continuar", async () => {
    setProfiles([{ id: "home", label: "Home", host: "127.0.0.1", relayPort: 8765 }]);
    const user = userEvent.setup();
    renderApp();

    await pairByCode(user);

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    // The active profile must not have moved while the dialog was running.
    // Plain text, not getByRole: the open Dialog marks the rest of the page
    // aria-hidden, which getByRole (accessibility-tree-aware) would miss.
    expect(screen.getByText("Home")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("New machine"));
    expect(screen.queryByText(en.shell.profiles.setup.connectedTitle)).not.toBeInTheDocument();
  });

  it("Esc on the ready screen leaves the active profile untouched", async () => {
    setProfiles([{ id: "home", label: "Home", host: "127.0.0.1", relayPort: 8765 }]);
    const user = userEvent.setup();
    renderApp();

    await pairByCode(user);
    await screen.findByText(en.shell.profiles.setup.connectedTitle);

    await user.keyboard("{Escape}");

    expect(screen.queryByText(en.shell.profiles.setup.connectedTitle)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Home");
  });

  it("won't let Escape close the dialog while still connecting, and 'Deixar para depois' doesn't reopen it once the connection settles", async () => {
    setProfiles([{ id: "home", label: "Home", host: "127.0.0.1", relayPort: 8765 }]);
    let resolveAcquire!: (endpoint: typeof SIDECAR_ENDPOINT) => void;
    acquireTailnetSidecarMock.mockImplementationOnce(() => new Promise((resolve) => (resolveAcquire = resolve)));
    const user = userEvent.setup();
    renderApp();

    await pairByCode(user);

    await screen.findByText(en.shell.profiles.setup.connectingTitle);
    await user.keyboard("{Escape}");
    expect(screen.getByText(en.shell.profiles.setup.connectingTitle)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));
    expect(screen.queryByText(en.shell.profiles.setup.connectingTitle)).not.toBeInTheDocument();
    // Untouched throughout — this mirrors the "Esc on the ready screen" case
    // above, just interrupted a stage earlier.
    expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Home");

    resolveAcquire(SIDECAR_ENDPOINT);
    await vi.waitFor(() => expect(screen.queryByText(en.shell.profiles.setup.connectingTitle)).not.toBeInTheDocument());
    expect(screen.queryByText(en.shell.profiles.setup.connectedTitle)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Home");
  });

  it("a deep-link import failing at connect shows a recoverable error instead of vanishing silently", async () => {
    setProfiles([{ id: "home", label: "Home", host: "127.0.0.1", relayPort: 8765 }]);
    acquireTailnetSidecarMock.mockRejectedValueOnce(new Error("join failed"));
    const user = userEvent.setup();
    renderApp();

    // Stands in for a resolved anywh://import-profile deep link — the
    // delivery mechanism itself (getCurrent/onOpenUrl -> this same call) is
    // already pinned in useProfileImport.test.ts.
    enqueueProfileSetup({
      source: "params",
      params: { label: "Remote", claimUrl: "https://broker.test/claim", joinCode: "DEEP-LINK" },
    });

    await screen.findByText(en.shell.profiles.setup.connectFailedTitle);
    expect(screen.getByText("Home")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.common.retry }));
    await screen.findByText(en.shell.profiles.setup.connectedTitle);
  });
});
