import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalRelayProbe } from "@/lib/install/localRelay";
import { getProfiles, setProfiles } from "@/lib/profiles/profiles";
import { __resetProfileSetupForTests, dismissProfileSetup, getProfileSetupState } from "@/lib/profiles/profileSetup";
import {
  __resetAdoptForTests,
  adoptLocalProfiles,
  adoptSteps,
  adoptableProfiles,
  canAdopt,
  getAdoptState,
  retryVerify,
  rollback,
} from "./adoptLocal";

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
    { id: "pessoal", label: "Pessoal", host: "127.0.0.1", port: 8766, homeOverride: null, registered: true },
    { id: "trabalho", label: "Trabalho", host: "127.0.0.1", port: 8765, homeOverride: null, registered: true },
    { id: "default", label: null, host: "127.0.0.1", port: 8799, homeOverride: null, registered: false },
  ],
  orphanDefault: true,
  previousRun: null,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

/** The relays on the other end of the network edge: which ports answer. */
let answering: Set<number>;

beforeEach(() => {
  localStorage.clear();
  setProfiles([]);
  __resetProfileSetupForTests();
  __resetAdoptForTests();
  answering = new Set([8765, 8766]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!answering.has(Number(url.port))) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(jsonResponse(url.pathname === "/sessions" ? { sessions: [] } : { profiles: [] }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ids = () => getProfiles().map((p) => p.id);

describe("adoptableProfiles", () => {
  it("takes every registered profile and never the stray default.env", () => {
    expect(adoptableProfiles(PROBE)).toEqual([
      { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8766, localRelay: true, unverified: true },
      { id: "trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: 8765, localRelay: true, unverified: true },
    ]);
  });

  it("adopts only an installed relay with something registered", () => {
    expect(canAdopt(PROBE)).toBe(true);
    expect(canAdopt({ ...PROBE, profiles: PROBE.profiles.filter((p) => !p.registered) })).toBe(false);
    expect(canAdopt({ ...PROBE, installed: false })).toBe(false);
    expect(canAdopt(null)).toBe(false);
  });
});

describe("adoptLocalProfiles", () => {
  it("saves every registered profile, verifies the first, and is ready once it answers", async () => {
    adoptLocalProfiles(PROBE);
    expect(ids()).toEqual(["pessoal", "trabalho"]);
    expect(getAdoptState()).toMatchObject({ status: "running", activeId: "pessoal" });
    expect(adoptSteps(getAdoptState()).map((s) => s.status)).toEqual(["done", "done", "running"]);

    await vi.waitFor(() => expect(getAdoptState().status).toBe("ready"));
    expect(adoptSteps(getAdoptState()).map((s) => s.status)).toEqual(["done", "done", "done"]);
    // Only the active one was dialled; the rest stay for the shell's sync.
    expect(getProfiles().find((p) => p.id === "pessoal")?.unverified).toBeUndefined();
    expect(getProfiles().find((p) => p.id === "trabalho")?.unverified).toBe(true);
  });

  it("prefers the default profile as the active one when the registry has it", () => {
    adoptLocalProfiles({
      ...PROBE,
      profiles: [PROBE.profiles[0], { id: "default", label: "Personal", host: "127.0.0.1", port: 8765, homeOverride: null, registered: true }],
    });
    expect(getAdoptState().activeId).toBe("default");
  });

  it("a relay on disk that doesn't answer is unresponsive, with the profiles still saved", async () => {
    answering.clear();
    adoptLocalProfiles(PROBE);
    await vi.waitFor(() => expect(getAdoptState().status).toBe("failed"));
    expect(getAdoptState().failure).toEqual({ code: "unresponsive", detail: "" });
    expect(adoptSteps(getAdoptState()).map((s) => s.status)).toEqual(["done", "done", "failed"]);
    expect(ids()).toEqual(["pessoal", "trabalho"]);
  });
});

describe("after a failed verification", () => {
  async function failed(): Promise<void> {
    answering.clear();
    adoptLocalProfiles(PROBE);
    await vi.waitFor(() => expect(getAdoptState().status).toBe("failed"));
  }

  it("try again keeps every adopted profile and only dials again", async () => {
    await failed();
    answering.add(8766);
    retryVerify();
    expect(ids()).toEqual(["pessoal", "trabalho"]);
    await vi.waitFor(() => expect(getAdoptState().status).toBe("ready"));
    expect(ids()).toEqual(["pessoal", "trabalho"]);
  });

  it("try again still dials when the failed verification was dismissed meanwhile", async () => {
    await failed();
    // The verification's own notice was closed; nothing is left to retry
    // on its side, so the active profile is resumed instead.
    dismissProfileSetup();
    expect(ids()).toEqual(["pessoal", "trabalho"]);
    answering.add(8766);
    retryVerify();
    await vi.waitFor(() => expect(getAdoptState().status).toBe("ready"));
  });

  it("giving up takes every adopted profile off this device and lets the verification go", async () => {
    await failed();
    rollback();
    expect(getProfiles()).toEqual([]);
    expect(getAdoptState()).toEqual({ status: "idle", profiles: [], activeId: null, failure: null });
    expect(getProfileSetupState().state).toBeNull();
  });

  it("giving up mid-verification leaves nothing behind either", async () => {
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(jsonResponse({ sessions: [] }));
          }),
      ),
    );
    adoptLocalProfiles(PROBE);
    await vi.waitFor(() => expect(getProfileSetupState().state?.status).toBe("verifying"));
    rollback();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getProfiles()).toEqual([]);
    expect(getAdoptState().status).toBe("idle");
    expect(getProfileSetupState().state).toBeNull();
  });
});
