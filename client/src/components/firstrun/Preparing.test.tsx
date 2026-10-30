import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Preparing } from "@/components/firstrun/Preparing";
import { en } from "@/i18n/en";
import type { LocalRelayProbe } from "@/lib/install/localRelay";
import { __resetAdoptForTests, adoptLocalProfiles } from "@/lib/profiles/adoptLocal";
import { getProfiles, setProfiles } from "@/lib/profiles/profiles";
import { __resetProfileSetupForTests } from "@/lib/profiles/profileSetup";

/**
 * The adoption half of the preparing screen, against the real adoption and
 * verification modules; only the network edge (`fetch`) is stubbed. The
 * install half needs the native installer and is driven in the UI tier.
 */

const PROBE: LocalRelayProbe = {
  platform: "linux",
  supported: true,
  containerized: null,
  installDir: "/home/x/.local/share/anywh",
  installed: true,
  installedVersion: "0.2.0",
  unitInstalled: true,
  envDir: "/home/x/.config/anywh/env",
  profiles: [
    {
      id: "pessoal",
      label: "pessoal",
      host: "127.0.0.1",
      port: 8766,
      homeOverride: null,
      registered: true,
    },
    {
      id: "trabalho",
      label: "trabalho",
      host: "127.0.0.1",
      port: 8765,
      homeOverride: null,
      registered: true,
    },
  ],
  orphanDefault: false,
  previousRun: null,
};

const copy = en.firstRun.preparing;
let answering: boolean;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetAdoptForTests();
  answering = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!answering) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(jsonResponse(url.pathname === "/sessions" ? { sessions: [] } : { profiles: [] }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAdopt() {
  const handlers = {
    onDone: vi.fn(),
    onCancel: vi.fn(),
    onTerminal: vi.fn(),
    onOtherMachine: vi.fn(),
  };
  render(<Preparing mode="adopt" {...handlers} />);
  return handlers;
}

describe("Preparing — adopting what's already here", () => {
  it("lists the profiles on this machine and moves on once the active one answers", async () => {
    adoptLocalProfiles(PROBE);
    const handlers = renderAdopt();
    expect(screen.getByRole("heading", { name: copy.adoptTitle })).toBeInTheDocument();
    expect(screen.getByText(copy.steps.read)).toBeInTheDocument();
    expect(screen.getByText("2 profiles: pessoal, trabalho")).toBeInTheDocument();
    expect(screen.getByText(copy.profilesHere)).toBeInTheDocument();
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1));
  });

  it("a relay that doesn't answer stops with try again, which keeps the profiles", async () => {
    answering = false;
    adoptLocalProfiles(PROBE);
    const user = userEvent.setup();
    const handlers = renderAdopt();

    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: copy.fail.titleStopped })).toBeInTheDocument();
    expect(alert).toHaveTextContent(copy.fail.codes.unresponsive.body);
    expect(screen.getByText(copy.fail.codes.unresponsive.line ?? "")).toBeInTheDocument();

    answering = true;
    await user.click(within(alert).getByRole("button", { name: copy.fail.actions.retry }));
    await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1));
    expect(getProfiles().map((p) => p.id)).toEqual(["pessoal", "trabalho"]);
  });

  it("continuing in the terminal leaves no adopted profile behind", async () => {
    answering = false;
    adoptLocalProfiles(PROBE);
    const user = userEvent.setup();
    const handlers = renderAdopt();

    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: copy.fail.actions.terminal }));
    expect(handlers.onTerminal).toHaveBeenCalledTimes(1);
    expect(getProfiles()).toEqual([]);
  });

  it("cancelling goes back to the welcome with nothing adopted", async () => {
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(jsonResponse({ sessions: [] }))))),
    );
    adoptLocalProfiles(PROBE);
    const user = userEvent.setup();
    const handlers = renderAdopt();

    await user.click(screen.getByRole("button", { name: copy.cancel }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(getProfiles()).toEqual([]);
    release();
  });

  it("Details shows what was read", async () => {
    adoptLocalProfiles(PROBE);
    const user = userEvent.setup();
    renderAdopt();
    await user.click(screen.getByRole("button", { name: copy.details }));
    expect(screen.getByText(/pessoal\s+127\.0\.0\.1:8766/)).toBeInTheDocument();
  });
});
