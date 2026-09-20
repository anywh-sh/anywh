import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";
import { AddProfileDialog } from "./AddProfileDialog";
import { en } from "@/i18n/en";

// The network edge is the one thing stubbed here (the client-side
// equivalent of the relay's `claude`-process boundary, per the testing
// doctrine): every call this dialog makes is a `fetch` against a relay that
// doesn't exist in a unit test. Everything else — the dialog, the portal,
// the dropdown, the checkbox — renders for real.

const activeProfile: Profile = { id: "pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: 8788 };

const copy = en.shell.profiles.add;

interface RelayState {
  agents: string[];
  loggedIn: boolean;
  snapshotFound: boolean;
  applyFails: boolean;
}

let relay: RelayState;
let applied: { home: string | null; bundleFiles: number } | null;
let createdWith: { label: string; home?: string; runtimeId?: string } | null;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

/** `vi.mocked(fetch).mock.calls`, typed as what this file actually passes —
 * `RequestInit["body"]` is a union wide enough (Blob, streams...) that
 * reading `.body` as text trips `no-base-to-string`. */
function fetchCalls(): [string, { body?: string }][] {
  return vi.mocked(fetch).mock.calls as unknown as [string, { body?: string }][];
}

beforeEach(() => {
  relay = { agents: ["claude", "codex"], loggedIn: true, snapshotFound: true, applyFails: false };
  applied = null;
  createdWith = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: { body?: string }) => {
      const url = new URL(input);
      if (url.pathname === "/host-info") {
        const agents = relay.agents.map((id) => ({ id, capabilities: {} }));
        return Promise.resolve(jsonResponse({ hostname: "box", platform: "linux", editor: null, agents }));
      }
      if (url.pathname === "/control/portability") {
        const files = relay.snapshotFound ? [{ path: ".claude/CLAUDE.md", bytes: 12 }, { path: ".claude/skills/deploy/SKILL.md", bytes: 30 }] : [];
        const snapshot = {
          runtimeId: url.searchParams.get("runtime"),
          found: relay.snapshotFound,
          files,
          mcpServers: relay.snapshotFound ? ["sentry"] : [],
          warnings: relay.snapshotFound ? [{ kind: "absolute-path", path: ".claude/settings.json", detail: "/home/someone/bin/lint" }] : [],
        };
        const full = url.searchParams.get("full") === "1";
        return Promise.resolve(jsonResponse(full ? { ...snapshot, files: files.map((file) => ({ ...file, contents: "eA==", executable: false })) } : snapshot));
      }
      if (url.pathname === "/control/profiles/validate") {
        return Promise.resolve(jsonResponse({ loggedIn: relay.loggedIn, account: "user@example.com", plan: "max" }));
      }
      if (url.pathname === "/control/profiles") {
        createdWith = JSON.parse(init?.body ?? "{}") as { label: string; home?: string; runtimeId?: string };
        return Promise.resolve(jsonResponse({ id: "client-x", label: createdWith.label, host: "127.0.0.1", port: 8790, colorIndex: 2 }));
      }
      if (url.pathname === "/control/portability/apply") {
        if (relay.applyFails) {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "disk full" }) } as Response);
        }
        const body = JSON.parse(init?.body ?? "{}") as { bundle: { files: unknown[] } };
        applied = { home: url.searchParams.get("home"), bundleFiles: body.bundle.files.length };
        return Promise.resolve(jsonResponse({ written: [".claude/CLAUDE.md"], rejected: [] }));
      }
      throw new Error(`unexpected fetch: ${input}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Radix renders the dialog and every menu into `document.body`, not the
 * container `render` returns (see the testing doctrine's note on portals). */
function body() {
  return within(document.body);
}

async function fillAndVerify(user: ReturnType<typeof userEvent.setup>, home: string) {
  await user.type(body().getByLabelText(copy.nameLabel), "Client X");
  if (home) await user.type(body().getByLabelText(copy.homeLabel), home);
  await user.click(body().getByRole("button", { name: copy.verify }));
  await screen.findByText(/Account confirmed/);
}

describe("AddProfileDialog", () => {
  it("offers every agent the host reports, and validates against the one picked", async () => {
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await user.click(await body().findByRole("button", { name: copy.runtimeLabel }));
    await user.click(await body().findByRole("menuitem", { name: /Codex/ }));
    await fillAndVerify(user, "/home/user/.anywh-client-x");

    const validateCall = fetchCalls().find(([url]) => url.includes("/control/profiles/validate"));
    expect(JSON.parse(validateCall?.[1].body ?? "{}")).toMatchObject({ runtimeId: "codex" });
  });

  it("names the picked agent in the not-logged-in instruction, instead of always saying claude", async () => {
    relay.loggedIn = false;
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await user.click(await body().findByRole("button", { name: copy.runtimeLabel }));
    await user.click(await body().findByRole("menuitem", { name: /Codex/ }));
    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    await user.click(body().getByRole("button", { name: copy.verify }));

    expect(await screen.findByText(/HOME=\/home\/user\/\.anywh-client-x codex login/)).toBeInTheDocument();
  });

  it("offers the copy only once a separate config path exists to copy into", async () => {
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    // With no config path the new profile shares the machine's default
    // account — the very configuration being read — so there is nothing to
    // carry anywhere.
    expect(body().queryByText(copy.copyLabel)).not.toBeInTheDocument();

    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    expect(await body().findByText(copy.copyLabel)).toBeInTheDocument();
    expect(body().getByText("Files: 2 · MCP servers: 1")).toBeInTheDocument();
    expect(body().getByText(copy.copyServersNote)).toBeInTheDocument();
    expect(body().getByText("Settings naming a path that may not exist here: 1")).toBeInTheDocument();
  });

  it("says nothing about copying when the host has nothing configured", async () => {
    relay.snapshotFound = false;
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    await waitFor(() => expect(fetchCalls().some(([url]) => url.includes("/control/portability"))).toBe(true));
    expect(body().queryByText(copy.copyLabel)).not.toBeInTheDocument();
  });

  it("writes the configuration into the new profile's home before closing the dialog", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    await body().findByText(copy.copyLabel);
    await fillAndVerify(user, "");
    await user.click(body().getByRole("button", { name: en.common.create }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createdWith).toMatchObject({ label: "Client X", home: "/home/user/.anywh-client-x", runtimeId: "claude" });
    // The destination is the *new* profile's home, and what's sent is the
    // full bundle (contents included), not the summary.
    expect(applied).toEqual({ home: "/home/user/.anywh-client-x", bundleFiles: 2 });
  });

  it("skips the copy when the checkbox is cleared, and still creates the profile", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    await user.click(await body().findByRole("checkbox"));
    await fillAndVerify(user, "");
    await user.click(body().getByRole("button", { name: en.common.create }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(applied).toBeNull();
  });

  it("keeps the created profile and reports the failure when only the copy fails", async () => {
    // Rolling back a profile the user asked for because an optional copy
    // failed would be the worse outcome — the copy can be redone by hand.
    relay.applyFails = true;
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    await body().findByText(copy.copyLabel);
    await fillAndVerify(user, "");
    await user.click(body().getByRole("button", { name: en.common.create }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(createdWith).not.toBeNull();
  });
});
