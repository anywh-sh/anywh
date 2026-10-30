import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProfiles, setProfiles } from "@/lib/profiles/profiles";
import { __resetProfileSetupForTests, enqueueProfileSetup } from "@/lib/profiles/profileSetup";
import { __resetFirstRunForTests } from "@/lib/profiles/firstRun";
import { __resetLocalInstallForTests } from "@/lib/install/localInstall";
import type {
  InstallDoneEvent,
  InstallLogEvent,
  InstallRunStatus,
  LocalRelayProbe,
  Prerequisites,
} from "@/lib/install/localRelay";
import { installFakeRelay, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * Path 01 — the in-app relay install — driven by click and keystroke with
 * the native edge (`lib/localRelay.ts`, the `relay_setup_*` commands and
 * their events) mocked: that edge is a Rust process spawning `install.sh`
 * on the real machine, which no test tier may do. Everything above it runs
 * for real: the recognition step, the wizard's state machine, the
 * porcelain-driven rows, the failure boxes, the hold on the setup queue,
 * the hand-over into verification and the shell.
 */
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [] }));

const native = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<LocalRelayProbe | null>>(),
  prerequisites: vi.fn<() => Promise<Prerequisites>>(),
  suggest: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn<() => Promise<InstallRunStatus | null>>(),
  confirmClose: vi.fn(),
  logHandlers: [] as Array<(event: InstallLogEvent) => void>,
  doneHandlers: [] as Array<(event: InstallDoneEvent) => void>,
}));

vi.mock("@/lib/install/localRelay", () => ({
  localInstallPossible: () => true,
  probeLocalRelay: () => native.probe(),
  checkPrerequisites: () => native.prerequisites(),
  suggestAddresses: () => native.suggest(),
  startLocalInstall: (params: unknown) => native.start(params),
  cancelLocalInstall: () => native.cancel(),
  getLocalInstallStatus: () => native.status(),
  confirmCloseDuringInstall: (action: unknown) => native.confirmClose(action),
  onInstallLog: async (handler: (event: InstallLogEvent) => void) => {
    native.logHandlers.push(handler);
    return () => {};
  },
  onInstallDone: async (handler: (event: InstallDoneEvent) => void) => {
    native.doneHandlers.push(handler);
    return () => {};
  },
  onCloseRequestedDuringInstall: async () => () => {},
}));

const { claimTailnetBundleMock, acquireTailnetSidecarMock, releaseTailnetSidecarMock, peekTailnetSidecarMock, resolveTailnetTargetMock, fetchConnectGrantMock } =
  vi.hoisted(() => ({
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
vi.mock("@/lib/profiles/tailnetBroker", () => ({ resolveTailnetTarget: resolveTailnetTargetMock, fetchConnectGrant: fetchConnectGrantMock }));

const EMPTY_PROBE: LocalRelayProbe = {
  platform: "linux",
  supported: true,
  containerized: null,
  installDir: "/home/x/.local/share/anywh",
  installed: false,
  installedVersion: null,
  unitInstalled: false,
  envDir: "/home/x/.config/anywh/env",
  profiles: [],
  orphanDefault: false,
  previousRun: null,
};

const HEALTHY: Prerequisites = {
  nodePath: "/usr/bin/node",
  nodeVersion: "22.4.0",
  nodeOk: true,
  agentBin: "claude",
  agentPath: "/usr/bin/claude",
  agentLoggedIn: true,
  agentError: null,
  systemdUser: true,
  xdgRuntimeDir: true,
  activeUnits: [],
};

const CANDIDATES = [
  { address: "100.99.146.5", kind: "tailnet" as const, interface: "tailscale0", recommended: true },
  { address: "192.168.0.48", kind: "lan" as const, interface: "enp1s0", recommended: false },
  { address: "127.0.0.1", kind: "loopback" as const, interface: "lo", recommended: false },
];

const RELAY = { host: "100.99.146.5", port: 8766 };
/** Where the easy path's relay lives: loopback, on the port the installer
 * picked. */
const LOCAL = { host: "127.0.0.1", port: 8767 };
const RUN_ID = "run-1";

function statusWith(lines: string[], extra: Partial<InstallRunStatus> = {}): InstallRunStatus {
  return {
    runId: RUN_ID,
    pid: 4242,
    alive: true,
    cancelled: false,
    exitCode: null,
    startedAt: 1,
    params: { profileId: null, profileLabel: "Studio", relayHost: RELAY.host, profileHome: null, mode: "prod" },
    lines: lines.map((line, index) => ({ seq: index + 1, line, event: null })),
    ok: false,
    profile: null,
    failure: null,
    ...extra,
  };
}

/** Emits porcelain lines the way Rust does — one event per line, in order. */
function emitLines(lines: string[], from: number): number {
  let seq = from;
  for (const line of lines) {
    seq += 1;
    const event = parse(line);
    for (const handler of native.logHandlers) handler({ runId: RUN_ID, seq, line, event });
  }
  return seq;
}

function parse(line: string): InstallLogEvent["event"] {
  const rest = line.startsWith("ANYWH ") ? line.slice(6) : null;
  if (!rest) return null;
  const [verb, ...parts] = rest.split(" ");
  if (verb === "step") return { kind: "step", step: parts[0] };
  if (verb === "done") return { kind: "done", step: parts[0], fields: fields(parts.slice(1)) };
  if (verb === "fail") return { kind: "fail", step: parts[0], code: parts[1], message: parts.slice(2).join(" ") };
  if (verb === "profile") return { kind: "profile", fields: fields(parts) };
  return null;
}

function fields(pairs: string[]): Record<string, string> {
  return Object.fromEntries(pairs.filter((p) => p.includes("=")).map((p) => p.split("=", 2) as [string, string]));
}

function fakeJsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let relay: FakeRelay;

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetFirstRunForTests();
  __resetLocalInstallForTests();
  relay = installFakeRelay();
  native.logHandlers.length = 0;
  native.doneHandlers.length = 0;
  native.probe.mockReset().mockResolvedValue(EMPTY_PROBE);
  native.prerequisites.mockReset().mockResolvedValue(HEALTHY);
  native.suggest.mockReset().mockResolvedValue(CANDIDATES);
  native.start.mockReset().mockResolvedValue({ runId: RUN_ID, logPath: "/tmp/run-1.log", started: true });
  native.cancel.mockReset().mockResolvedValue(undefined);
  native.status.mockReset().mockResolvedValue(statusWith([]));
  native.confirmClose.mockReset();
  claimTailnetBundleMock.mockReset().mockResolvedValue({ nodeId: "node-1", controlUrl: "https://ctrl.test", authKey: "key", brokerUrl: "https://broker.test/w1" });
  resolveTailnetTargetMock.mockReset().mockResolvedValue({ target: "100.64.0.1:8443", token: "t" });
  acquireTailnetSidecarMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 9999 });
  releaseTailnetSidecarMock.mockReset();
  peekTailnetSidecarMock.mockReset().mockReturnValue(Promise.resolve({ host: "127.0.0.1", port: 9999 }));
  fetchConnectGrantMock.mockReset().mockResolvedValue({ endpoint: { host: "127.0.0.1", port: 9999 }, token: "t" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(`${RELAY.host}:${String(RELAY.port)}/sessions`)) return fakeJsonResponse({ sessions: [] });
      if (url.includes(`${LOCAL.host}:${String(LOCAL.port)}/sessions`)) return fakeJsonResponse({ sessions: [] });
      if (url.includes("127.0.0.1:9999/sessions")) return fakeJsonResponse({ sessions: [] });
      return fakeJsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

const local = en.firstRun.local;

/** The easy path: one click on the card and the install starts — no
 * field, no address, no second question. */
async function startEasyInstall(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.localTitle) }));
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
}

function finishRun(profile: { id: string; port: number; host: string }): Promise<void> {
  const finalStatus = statusWith([], { alive: false, exitCode: 0, ok: true, profile: { ...profile, mode: "prod" } });
  native.status.mockResolvedValue(finalStatus);
  return act(async () => {
    for (const handler of native.doneHandlers) handler({ runId: RUN_ID, exitCode: 0, ok: true, profile: finalStatus.profile, failure: null });
  });
}

describe("path 01 — install on this machine", () => {
  it("offers the local path first on a machine with nothing on it", async () => {
    renderApp();
    const card = await screen.findByRole("button", { name: new RegExp(en.firstRun.home.localTitle) });
    expect(card).toBeEnabled();
    expect(card).toHaveTextContent("01");
    expect(screen.getByRole("button", { name: new RegExp(en.firstRun.home.connectTitle) })).toHaveTextContent("02");
  });

  it("shows the card disabled, with the reason, inside a sandbox", async () => {
    native.probe.mockResolvedValue({ ...EMPTY_PROBE, supported: false, containerized: "flatpak" });
    renderApp();
    const card = await screen.findByRole("button", { name: new RegExp(en.firstRun.home.localTitle) });
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent(en.firstRun.home.localUnavailable.replace("{container}", "flatpak"));
  });

  it("adopts the profiles of a relay already on this machine without installing anything", async () => {
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      installed: true,
      installedVersion: "0.1.1",
      unitInstalled: true,
      orphanDefault: true,
      profiles: [
        { id: "home", label: "Home", host: RELAY.host, port: RELAY.port, homeOverride: null, registered: true },
        { id: "default", label: null, host: "127.0.0.1", port: 8765, homeOverride: null, registered: false },
      ],
    });
    const user = userEvent.setup();
    renderApp();

    await screen.findByText(en.firstRun.adopt.title);
    expect(screen.getByText(en.firstRun.adopt.orphanNote)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.firstRun.adopt.adoptOne }));

    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    expect(native.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("Home"));
    expect(getProfiles()).toEqual([expect.objectContaining({ id: "home", localRelay: true, host: RELAY.host, relayPort: RELAY.port })]);
    expect(getProfiles()[0].unverified).toBeUndefined();
  });

  it("installs in three steps from one click, to a shell whose one profile is the installer's", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    // The easy path asks nothing: `default`, labelled in the reader's
    // language, on loopback.
    expect(native.start).toHaveBeenCalledWith({ profileLabel: local.defaultLabel, profileId: "default", relayHost: "127.0.0.1", mode: "prod" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    let seq = emitLines(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download", "fetching anywh-relay-linux-x64.tar.gz"], 0);
    await screen.findByText("fetching anywh-relay-linux-x64.tar.gz");
    expect(screen.getByText(local.steps.check)).toBeInTheDocument();
    expect(screen.getByText(local.steps.install)).toBeInTheDocument();
    expect(screen.getByText(local.steps.start)).toBeInTheDocument();

    seq = emitLines(
      [
        "ANYWH done download asset=anywh-relay-linux-x64.tar.gz",
        "ANYWH step install",
        "ANYWH done install dir=/home/x/.local/share/anywh",
        "ANYWH step service",
        "ANYWH done service manager=systemd",
        "ANYWH step profile",
        `ANYWH profile id=default port=${LOCAL.port} host=${LOCAL.host} mode=prod env=/e/default.env`,
        "ANYWH done profile id=default",
        "ANYWH done ok service=systemd",
      ],
      seq,
    );
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });

    // Verification runs through the same pipeline every other path uses.
    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.continueToProfile }));

    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent(local.defaultLabel));
    expect(getProfiles()).toHaveLength(1);
    // The port is the installer's, never one made here.
    expect(getProfiles()[0]).toMatchObject({ id: "default", label: local.defaultLabel, host: LOCAL.host, relayPort: LOCAL.port, localRelay: true });
    expect(getProfiles()[0].unverified).toBeUndefined();
    expect(localStorage.getItem("anywh:last-profile")).toBe("default");
  });

  it("never asks about the agent CLI — a logged-out or missing one still installs", async () => {
    // A relay installs, starts and serves with no usable agent CLI and
    // resolves the binary when a turn spawns it; which agents are here is
    // the relay's to say, after the install.
    native.prerequisites.mockResolvedValue({ ...HEALTHY, agentPath: null, agentLoggedIn: null });
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/claude login/)).not.toBeInTheDocument();
  });

  it("still stops at the check for a prerequisite the relay genuinely can't run without", async () => {
    native.prerequisites.mockResolvedValueOnce({ ...HEALTHY, nodePath: null, nodeOk: false });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: new RegExp(en.firstRun.home.localTitle) }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(local.failures.node_missing);
    expect(within(alert).getByRole("button", { name: local.actions.recheck })).toBeInTheDocument();
    expect(native.start).not.toHaveBeenCalled();

    // Fixed outside the app; checking again goes straight on to the install.
    native.prerequisites.mockResolvedValue(HEALTHY);
    await user.click(within(alert).getByRole("button", { name: local.actions.recheck }));
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
  });

  it("a checksum mismatch stops the install without a blind retry", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);

    emitLines(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download", "ANYWH fail download checksum_mismatch checksum mismatch for x (expected a, got b)"], 0);
    native.status.mockResolvedValue(statusWith([], { alive: false, exitCode: 1, failure: { step: "download", code: "checksum_mismatch", message: "checksum mismatch for x (expected a, got b)" } }));
    await act(async () => {
      for (const handler of native.doneHandlers) {
        handler({ runId: RUN_ID, exitCode: 1, ok: false, profile: null, failure: { step: "download", code: "checksum_mismatch", message: "checksum mismatch for x (expected a, got b)" } });
      }
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(local.failures.checksum_mismatch);
    expect(alert).toHaveTextContent("expected a, got b");
    expect(within(alert).queryByRole("button", { name: local.actions.retry })).not.toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: local.actions.terminal })).toBeInTheDocument();
    expect(screen.getByText(local.install.failed)).toBeInTheDocument();
    expect(getProfiles()).toHaveLength(0);
  });

  it("a relay that installs but doesn't answer is dialled again on retry, nothing reinstalled", async () => {
    let answering = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes(`${LOCAL.host}:${String(LOCAL.port)}/`)) return fakeJsonResponse({}, 404);
        // Nothing listening yet: the request never gets a response.
        if (!answering) throw new TypeError("Failed to fetch");
        return fakeJsonResponse({ sessions: [] });
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });

    const sentence = await screen.findByText(local.failures.unresponsive);
    const box = sentence.closest("[role=alert]") as HTMLElement;
    expect(getProfiles()).toEqual([expect.objectContaining({ id: "default", unverified: true })]);

    // The verification's own notice is left for later; the install's
    // failure stays, with its own way forward.
    await user.click(screen.getByRole("button", { name: en.shell.profiles.setup.later }));
    answering = true;
    await user.click(within(box).getByRole("button", { name: local.actions.retry }));
    await screen.findByText(en.shell.profiles.setup.connectedTitle);
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(local.failures.unresponsive)).not.toBeInTheDocument();
  });

  it("a link arriving mid-install waits, visibly, and runs only once the install is over", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);

    // Stands in for a deep link arriving now.
    const link = { source: "params" as const, params: { label: "Remote", claimUrl: "https://broker.test/claim", joinCode: "MID-INSTALL" } };
    expect(enqueueProfileSetup(link)).toBe(true);
    await screen.findByText(local.install.pendingLink);
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();
    expect(screen.queryByText(en.shell.profiles.setup.connectingTitle)).not.toBeInTheDocument();

    // Discarding frees the key: the same link is accepted again.
    await user.click(screen.getByRole("button", { name: local.install.discard }));
    expect(screen.queryByText(local.install.pendingLink)).not.toBeInTheDocument();
    expect(enqueueProfileSetup(link)).toBe(true);
    await screen.findByText(local.install.pendingLink);

    // The install ends; the hold lifts and the waiting link runs.
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });
    await vi.waitFor(() => expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1));
  });

  it("re-attaches to an install still running from a previous launch, log from the start", async () => {
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      previousRun: statusWith(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download"], { alive: true }),
    });
    renderApp();

    await screen.findByText(local.notes.reattached);
    expect(screen.getByText(local.steps.install)).toBeInTheDocument();
    expect(native.start).not.toHaveBeenCalled();
  });

  it("an install interrupted by a dead app resumes on its own, with the same parameters", async () => {
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      installed: true,
      previousRun: statusWith(["ANYWH step download"], { alive: false, exitCode: null }),
    });
    renderApp();

    await screen.findByText(local.notes.resuming);
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
    expect(native.start).toHaveBeenCalledWith({ profileLabel: "Studio", profileId: undefined, relayHost: RELAY.host, mode: "prod" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
