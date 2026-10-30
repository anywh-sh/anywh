import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getProfiles, setProfiles } from "@/lib/profiles/profiles";
import { __resetProfileSetupForTests, enqueueProfileSetup } from "@/lib/profiles/profileSetup";
import { __resetFirstRunForTests } from "@/lib/profiles/firstRun";
import { __resetLocalInstallForTests } from "@/lib/install/localInstall";
import { __resetAdoptForTests } from "@/lib/profiles/adoptLocal";
import type {
  InstallDoneEvent,
  InstallLogEvent,
  InstallRunStatus,
  LocalRelayProbe,
  Prerequisites,
} from "@/lib/install/localRelay";
import { installFakeRelay, type FakeAgent, type FakeRelay } from "./helpers/fakeRelay";
import { renderApp } from "./helpers/renderApp";
import { en } from "@/i18n/en";

/**
 * Setting up this machine — the in-app install, or the adoption of one
 * already here — driven by click and keystroke with
 * the native edge (`lib/localRelay.ts`, the `relay_setup_*` commands and
 * their events) mocked: that edge is a Rust process spawning `install.sh`
 * on the real machine, which no test tier may do. Everything above it runs
 * for real: the probe, the welcome, the three steps of the preparing
 * screen, its failure box, the hold on the setup queue, the verification,
 * the agents step and the hand-over into the shell.
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
  onInstallLog: async (handler: (event: InstallLogEvent) => void) => {
    native.logHandlers.push(handler);
    return () => {};
  },
  onInstallDone: async (handler: (event: InstallDoneEvent) => void) => {
    native.doneHandlers.push(handler);
    return () => {};
  },
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
/** Ports whose relay never answers — a profile on disk with nothing up. */
let silent: number[] = [];

const CLAUDE: FakeAgent = { id: "claude", installed: true, version: "2.1.3", loggedIn: true, loginCommand: "claude auth login", installUrl: null };

beforeEach(() => {
  silent = [];
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetFirstRunForTests();
  __resetLocalInstallForTests();
  __resetAdoptForTests();
  relay = installFakeRelay("fake relay reply", { control: { agents: [CLAUDE] } });
  const relayFetch = globalThis.fetch;
  native.logHandlers.length = 0;
  native.doneHandlers.length = 0;
  native.probe.mockReset().mockResolvedValue(EMPTY_PROBE);
  native.prerequisites.mockReset().mockResolvedValue(HEALTHY);
  native.suggest.mockReset().mockResolvedValue(CANDIDATES);
  native.start.mockReset().mockResolvedValue({ runId: RUN_ID, logPath: "/tmp/run-1.log", started: true });
  native.cancel.mockReset().mockResolvedValue(undefined);
  native.status.mockReset().mockResolvedValue(statusWith([]));
  claimTailnetBundleMock.mockReset().mockResolvedValue({ nodeId: "node-1", controlUrl: "https://ctrl.test", authKey: "key", brokerUrl: "https://broker.test/w1" });
  resolveTailnetTargetMock.mockReset().mockResolvedValue({ target: "100.64.0.1:8443", token: "t" });
  acquireTailnetSidecarMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 9999 });
  releaseTailnetSidecarMock.mockReset();
  peekTailnetSidecarMock.mockReset().mockReturnValue(Promise.resolve({ host: "127.0.0.1", port: 9999 }));
  fetchConnectGrantMock.mockReset().mockResolvedValue({ endpoint: { host: "127.0.0.1", port: 9999 }, token: "t" });

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/sessions")) {
        if (silent.some((port) => url.includes(`:${String(port)}/`))) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(fakeJsonResponse({ sessions: [] }));
      }
      return relayFetch(input, init);
    }),
  );
});

afterEach(() => {
  cleanup();
  relay.uninstall();
});

const welcome = en.firstRun.welcome;
const preparing = en.firstRun.preparing;
const fail = preparing.fail;

/** Two clicks and no field: "set up on this machine", and the install
 * starts. */
async function startEasyInstall(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: welcome.cta }));
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
}

function finishRun(profile: { id: string; port: number; host: string }): Promise<void> {
  const finalStatus = statusWith([], { alive: false, exitCode: 0, ok: true, profile: { ...profile, mode: "prod" } });
  native.status.mockResolvedValue(finalStatus);
  return act(async () => {
    for (const handler of native.doneHandlers) handler({ runId: RUN_ID, exitCode: 0, ok: true, profile: finalStatus.profile, failure: null });
  });
}

function failRun(step: string, code: string, message: string): Promise<void> {
  const failure = { step, code, message };
  native.status.mockResolvedValue(statusWith([], { alive: false, exitCode: 1, failure }));
  return act(async () => {
    for (const handler of native.doneHandlers) handler({ runId: RUN_ID, exitCode: 1, ok: false, profile: null, failure });
  });
}

async function startWithClaude(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: en.firstRun.agents.startWith.replace("{agent}", en.chat.composer.agentNames.claude) }));
}

const TWO_PROFILES: LocalRelayProbe = {
  ...EMPTY_PROBE,
  installed: true,
  installedVersion: "0.2.0",
  unitInstalled: true,
  orphanDefault: true,
  profiles: [
    { id: "pessoal", label: "pessoal", host: LOCAL.host, port: LOCAL.port, homeOverride: null, registered: true },
    { id: "trabalho", label: "trabalho", host: LOCAL.host, port: 8768, homeOverride: null, registered: true },
    { id: "default", label: null, host: "127.0.0.1", port: 8799, homeOverride: null, registered: false },
  ],
};

describe("set up on this machine", () => {
  it("opens on the welcome with the way in enabled", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: welcome.cta })).toBeEnabled();
    expect(screen.getByRole("button", { name: welcome.otherMachine })).toBeInTheDocument();
  });

  it("inside a sandbox the way in is off, with the reason", async () => {
    native.probe.mockResolvedValue({ ...EMPTY_PROBE, supported: false, containerized: "flatpak" });
    renderApp();
    await screen.findByText(welcome.container.replace("{container}", "flatpak"));
    expect(screen.getByRole("button", { name: welcome.cta })).toBeDisabled();
  });

  it("installs in three steps from two clicks, on to the agents and into the shell", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    // The easy path asks nothing: `default`, labelled in the reader's
    // language, on loopback.
    expect(native.start).toHaveBeenCalledWith({ profileLabel: en.firstRun.profile.defaultLabel, profileId: "default", relayHost: "127.0.0.1", mode: "prod" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: preparing.title });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    let seq = emitLines(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download", "fetching anywh-relay-linux-x64.tar.gz"], 0);
    // The step says what it is doing in the reader's words; the
    // installer's own lines are in Details.
    await screen.findByText(preparing.sub.download);
    expect(screen.queryByText("fetching anywh-relay-linux-x64.tar.gz")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: preparing.details }));
    expect(screen.getByText(/fetching anywh-relay-linux-x64\.tar\.gz/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: preparing.details }));
    for (const step of [preparing.steps.check, preparing.steps.install, preparing.steps.start]) expect(screen.getAllByText(step).length).toBeGreaterThan(0);
    // A screen reader hears the step that changed, once — not the timer.
    expect(screen.getAllByRole("status").some((region) => region.textContent === preparing.steps.install)).toBe(true);

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

    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    await startWithClaude(user);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent(en.firstRun.profile.defaultLabel));
    expect(getProfiles()).toHaveLength(1);
    // The port is the installer's, never one made here.
    expect(getProfiles()[0]).toMatchObject({ id: "default", label: en.firstRun.profile.defaultLabel, host: LOCAL.host, relayPort: LOCAL.port, localRelay: true });
    expect(getProfiles()[0].unverified).toBeUndefined();
    expect(localStorage.getItem("anywh:last-profile")).toBe("default");
  });

  it("stops at the check for a runtime the machine lacks, and checking again goes on", async () => {
    native.prerequisites.mockResolvedValueOnce({ ...HEALTHY, nodePath: null, nodeOk: false });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: fail.titleMissing })).toBeInTheDocument();
    expect(alert).toHaveTextContent(fail.codes.node_missing.body);
    expect(within(alert).getByRole("link", { name: fail.codes.node_missing.link?.label })).toBeInTheDocument();
    expect(native.start).not.toHaveBeenCalled();

    native.prerequisites.mockResolvedValue(HEALTHY);
    await user.click(within(alert).getByRole("button", { name: fail.actions.recheck }));
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
  });

  it("a relay already running is said in the reader's words, its units only in Details", async () => {
    native.prerequisites.mockResolvedValueOnce({ ...HEALTHY, activeUnits: ["anywh-relay@pessoal.service"] });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));

    await screen.findByRole("alert");
    expect(screen.getByText(fail.codes.relay_running.line ?? "")).toBeInTheDocument();
    expect(screen.queryByText(/anywh-relay@pessoal/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: preparing.details }));
    expect(screen.getByText(/anywh-relay@pessoal\.service/)).toBeInTheDocument();
  });

  it("a checksum mismatch stops without a blind retry, and Back returns to the welcome", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);

    emitLines(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download"], 0);
    await failRun("download", "checksum_mismatch", "checksum mismatch for x (expected a, got b)");

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: fail.titleStopped })).toBeInTheDocument();
    expect(alert).toHaveTextContent(fail.codes.checksum_mismatch.body);
    expect(screen.getByText("checksum mismatch for x (expected a, got b)")).toBeInTheDocument();
    expect(within(alert).queryByRole("button", { name: fail.actions.retry })).not.toBeInTheDocument();
    expect(getProfiles()).toHaveLength(0);

    await user.click(within(alert).getByRole("button", { name: fail.actions.back }));
    await screen.findByRole("button", { name: welcome.cta });
  });

  it("continuing in the terminal from a failure opens the advanced options' terminal tab", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    await failRun("download", "download_failed", "curl: (6) Could not resolve host: github.com");

    const alert = await screen.findByRole("alert");
    expect(screen.getByText("curl: (6) Could not resolve host: github.com")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: fail.actions.terminal }));
    await screen.findByRole("heading", { name: en.firstRun.advanced.title });
    expect(screen.getByRole("button", { name: en.firstRun.advanced.terminal.done })).toBeInTheDocument();
  });

  it("cancelling goes back to the welcome", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    emitLines(["ANYWH step download"], 0);
    await user.click(await screen.findByRole("button", { name: preparing.cancel }));
    expect(native.cancel).toHaveBeenCalledTimes(1);
    native.status.mockResolvedValue(statusWith(["ANYWH step download"], { alive: false, cancelled: true, exitCode: 130 }));
    await act(async () => {
      for (const handler of native.doneHandlers) handler({ runId: RUN_ID, exitCode: 130, ok: false, profile: null, failure: null });
    });
    await screen.findByRole("button", { name: welcome.cta });
  });

  it("setting up again after an install that stopped at the start adopts what it left, instead of reinstalling", async () => {
    silent = [LOCAL.port];
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });
    await screen.findByText(fail.codes.unresponsive.body);

    // What that run left on disk: anywh installed, its profile registered.
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      installed: true,
      profiles: [{ id: "default", label: "Personal", host: LOCAL.host, port: LOCAL.port, homeOverride: null, registered: true }],
    });
    silent = [];
    await user.click(screen.getByRole("button", { name: preparing.cancel }));
    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it("cancelling while this machine is still being checked starts nothing", async () => {
    let finishCheck: (value: Prerequisites) => void = () => {};
    native.prerequisites.mockImplementationOnce(() => new Promise<Prerequisites>((resolve) => (finishCheck = resolve)));
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    await user.click(await screen.findByRole("button", { name: preparing.cancel }));
    await screen.findByRole("button", { name: welcome.cta });

    // The check answers after the reader left: nothing may follow from it.
    await act(async () => {
      finishCheck(HEALTHY);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(native.start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: welcome.cta })).toBeInTheDocument();
  });

  it("a relay that installs but doesn't answer is dialled again on retry, nothing reinstalled", async () => {
    silent = [LOCAL.port];
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(fail.codes.unresponsive.body);
    expect(getProfiles()).toEqual([expect.objectContaining({ id: "default", unverified: true })]);

    silent = [];
    await user.click(within(alert).getByRole("button", { name: fail.actions.retry }));
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it("after another machine failed and the reader came back, setting up here still verifies", async () => {
    silent = [9];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.otherMachine }));
    await user.click(await screen.findByRole("tab", { name: en.firstRun.other.modes.address }));
    await user.type(screen.getByRole("textbox", { name: en.firstRun.other.address.host }), "10.0.0.9");
    const port = screen.getByRole("textbox", { name: en.firstRun.other.address.port });
    await user.clear(port);
    await user.type(port, "9");
    await user.click(screen.getByRole("button", { name: en.firstRun.other.connect }));
    await screen.findByText(en.firstRun.other.failed.verify);

    await user.click(screen.getByRole("button", { name: en.firstRun.frame.back }));
    await startEasyInstall(user);
    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
  });

  it("an adoption after another machine failed still connects", async () => {
    native.probe.mockResolvedValue(TWO_PROFILES);
    silent = [9];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.otherMachine }));
    await user.click(await screen.findByRole("tab", { name: en.firstRun.other.modes.address }));
    await user.type(screen.getByRole("textbox", { name: en.firstRun.other.address.host }), "10.0.0.9");
    const port = screen.getByRole("textbox", { name: en.firstRun.other.address.port });
    await user.clear(port);
    await user.type(port, "9");
    await user.click(screen.getByRole("button", { name: en.firstRun.other.connect }));
    await screen.findByText(en.firstRun.other.failed.verify);

    await user.click(screen.getByRole("button", { name: en.firstRun.frame.back }));
    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
  });

  it("a link arriving mid-install waits, and runs only after this machine's profile", async () => {
    const user = userEvent.setup();
    renderApp();
    await startEasyInstall(user);

    // Stands in for a deep link arriving now.
    const link = { source: "params" as const, params: { label: "Remote", claimUrl: "https://broker.test/claim", joinCode: "MID-INSTALL" } };
    expect(enqueueProfileSetup(link)).toBe(true);
    await screen.findByRole("heading", { name: preparing.title });
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();

    await finishRun({ id: "default", port: LOCAL.port, host: LOCAL.host });
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(claimTailnetBundleMock).not.toHaveBeenCalled();

    // Leaving the first run lets the waiting link through, into the shell.
    await startWithClaude(user);
    await vi.waitFor(() => expect(claimTailnetBundleMock).toHaveBeenCalledTimes(1));
  });

  it("re-attaches to an install still running from a previous launch, without the welcome", async () => {
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      previousRun: statusWith(["ANYWH step prereqs", "ANYWH done prereqs node=22.4.0", "ANYWH step download"], { alive: true }),
    });
    renderApp();

    await screen.findByText(preparing.reattached);
    expect(screen.getByText(preparing.steps.install)).toBeInTheDocument();
    expect(native.start).not.toHaveBeenCalled();
  });

  it("a run that ended while the app was starting is read from disk, not waited on", async () => {
    native.probe.mockResolvedValue({ ...EMPTY_PROBE, previousRun: statusWith(["ANYWH step download"], { alive: true }) });
    // By the time the listeners are attached it is over: its done event
    // went out with nobody listening.
    native.status.mockResolvedValue(
      statusWith(["ANYWH done ok service=systemd"], { alive: false, exitCode: 0, ok: true, profile: { id: "default", port: LOCAL.port, host: LOCAL.host, mode: "prod" } }),
    );
    renderApp();
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
  });

  it("an install interrupted by a dead app resumes on its own, with the same parameters", async () => {
    native.probe.mockResolvedValue({
      ...EMPTY_PROBE,
      installed: true,
      previousRun: statusWith(["ANYWH step download"], { alive: false, exitCode: null }),
    });
    renderApp();

    await screen.findByText(preparing.resuming);
    await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
    expect(native.start).toHaveBeenCalledWith({ profileLabel: "Studio", profileId: undefined, relayHost: RELAY.host, mode: "prod" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("anywh already on this machine", () => {
  it("adopts every registered profile, installs nothing, and goes on to the agents", async () => {
    native.probe.mockResolvedValue(TWO_PROFILES);
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(native.start).not.toHaveBeenCalled();
    expect(getProfiles().map((p) => p.id)).toEqual(["pessoal", "trabalho"]);

    await startWithClaude(user);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: en.shell.profiles.activeProfile })).toHaveTextContent("pessoal"));
  });

  it("a relay that doesn't answer: try again keeps the profiles", async () => {
    native.probe.mockResolvedValue(TWO_PROFILES);
    silent = [LOCAL.port];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: fail.titleStopped })).toBeInTheDocument();
    expect(screen.getByText(preparing.profilesHere)).toBeInTheDocument();
    silent = [];
    await user.click(within(alert).getByRole("button", { name: fail.actions.retry }));
    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(getProfiles().map((p) => p.id)).toEqual(["pessoal", "trabalho"]);
  });

  it("a relaunch in the middle of adopting two profiles comes back to it, not to the shell", async () => {
    // What the previous launch left: both profiles saved, neither verified.
    setProfiles([
      { id: "pessoal", label: "pessoal", host: LOCAL.host, relayPort: LOCAL.port, localRelay: true, unverified: true },
      { id: "trabalho", label: "trabalho", host: LOCAL.host, relayPort: 8768, localRelay: true, unverified: true },
    ]);
    localStorage.setItem("anywh:first-run:adopting", "1");
    native.probe.mockResolvedValue(TWO_PROFILES);
    renderApp();

    await screen.findByRole("heading", { name: en.firstRun.agents.title });
    expect(screen.queryByRole("button", { name: en.shell.profiles.activeProfile })).not.toBeInTheDocument();
    expect(localStorage.getItem("anywh:first-run:adopting")).toBeNull();
  });

  it("giving up with Cancel goes back to the welcome with no profile behind, and the next try installs", async () => {
    native.probe.mockResolvedValue(TWO_PROFILES);
    silent = [LOCAL.port];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: preparing.cancel }));
    await screen.findByRole("button", { name: welcome.cta });
    expect(getProfiles()).toEqual([]);

    await startEasyInstall(user);
    await screen.findByRole("heading", { name: preparing.title });
  });

  it("giving up with Continue in the terminal leaves no profile behind either", async () => {
    native.probe.mockResolvedValue(TWO_PROFILES);
    silent = [LOCAL.port];
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: welcome.cta }));
    const alert = await screen.findByRole("alert");

    await user.click(within(alert).getByRole("button", { name: fail.actions.terminal }));
    await screen.findByRole("heading", { name: en.firstRun.advanced.title });
    expect(getProfiles()).toEqual([]);
  });
});
