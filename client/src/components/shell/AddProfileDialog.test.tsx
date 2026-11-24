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
  /** What `POST /control/profiles` waits on before answering, and whether
   * it then fails. */
  createGate: Promise<void>;
  createFails: boolean;
}

let relay: RelayState;
let applied: { home: string | null; bundleFiles: number } | null;
let createdWith: { label: string; home?: string; draftId?: string; sharing?: unknown; runtimeId?: string } | null;
let discarded: string[];

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
  relay = { agents: ["claude", "codex"], loggedIn: true, snapshotFound: true, applyFails: false, createGate: Promise.resolve(), createFails: false };
  applied = null;
  createdWith = null;
  discarded = [];
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
      if (url.pathname === "/control/profiles/draft") {
        return Promise.resolve(jsonResponse({ id: "client-x" }));
      }
      if (url.pathname.startsWith("/control/profiles/draft/")) {
        discarded.push(url.pathname.slice("/control/profiles/draft/".length));
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.pathname === "/control/profiles/validate") {
        return Promise.resolve(jsonResponse({ loggedIn: relay.loggedIn, account: "user@example.com", plan: "max" }));
      }
      if (url.pathname === "/control/profiles") {
        createdWith = JSON.parse(init?.body ?? "{}") as { label: string; home?: string; draftId?: string; sharing?: unknown; runtimeId?: string };
        const label = createdWith.label;
        return relay.createGate.then(() =>
          relay.createFails
            ? ({ ok: false, status: 500, json: () => Promise.resolve({ error: "failed to provision profile" }) } as Response)
            : jsonResponse({ id: "client-x", label, host: "127.0.0.1", port: 8790, colorIndex: 2 }),
        );
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

/** Name (and optionally a custom home under Advanced), then Continue: the
 * dialog reserves a draft (or uses the home) and checks the sign-in. */
async function fillAndContinue(user: ReturnType<typeof userEvent.setup>, home = "") {
  await user.type(body().getByLabelText(copy.nameLabel), "Client X");
  if (home) {
    await user.click(body().getByRole("button", { name: copy.advanced }));
    await user.type(body().getByLabelText(copy.homeLabel), home);
  }
  await user.click(body().getByRole("button", { name: copy.continue }));
}

function stubWebSocket(): string[] {
  const opened: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      readonly OPEN = 1;
      readyState = 1;
      onmessage = null;
      onclose = null;
      constructor(url: string) {
        opened.push(url);
      }
      send() {}
      close() {}
    },
  );
  return opened;
}

describe("AddProfileDialog", () => {
  it("creates a profile with its own config folders: a draft, a sign-in check there, then the choices", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    // Nothing to type but a name: no path field until Advanced is opened.
    expect(body().queryByLabelText(copy.homeLabel)).not.toBeInTheDocument();
    await user.click(within(body().getByRole("radiogroup", { name: copy.sharing.categories.instructions })).getByRole("radio", { name: copy.sharing.shared }));
    await fillAndContinue(user);
    await screen.findByText(/Account confirmed: user@example.com/);

    const validateCall = fetchCalls().find(([url]) => url.includes("/control/profiles/validate"));
    expect(JSON.parse(validateCall?.[1].body ?? "{}")).toMatchObject({ draftId: "client-x", runtimeId: "claude" });

    await user.click(body().getByRole("button", { name: en.common.create }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createdWith).toMatchObject({
      label: "Client X",
      draftId: "client-x",
      sharing: { instructions: "shared", preferences: "separate", mcp: "separate" },
    });
    expect(createdWith?.home).toBeUndefined();
    // Created: the dialog closing must not drop the profile's folders.
    expect(discarded).toEqual([]);
  });

  it("defaults every category to separate", async () => {
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);
    for (const category of ["instructions", "preferences", "mcp"] as const) {
      const group = body().getByRole("radiogroup", { name: copy.sharing.categories[category] });
      expect(within(group).getByRole("radio", { name: copy.sharing.separate })).toHaveAttribute("aria-checked", "true");
    }
    await fillAndContinue(user);
    await screen.findByText(/Account confirmed/);
    await user.click(body().getByRole("button", { name: en.common.create }));
    await waitFor(() => expect(createdWith).toMatchObject({ sharing: { instructions: "separate", preferences: "separate", mcp: "separate" } }));
  });

  it("offers every agent the host reports, with its logo, and checks the one picked", async () => {
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await user.click(await body().findByRole("button", { name: copy.runtimeLabel }));
    const codex = await body().findByRole("menuitem", { name: /Codex/ });
    expect(codex.querySelector("svg")).not.toBeNull();
    await user.click(codex);
    await fillAndContinue(user);
    await screen.findByText(/Account confirmed/);

    const validateCall = fetchCalls().find(([url]) => url.includes("/control/profiles/validate"));
    expect(JSON.parse(validateCall?.[1].body ?? "{}")).toMatchObject({ runtimeId: "codex" });
  });

  it("signs the picked agent in straight into the draft's folders, through the active relay", async () => {
    relay.loggedIn = false;
    const opened = stubWebSocket();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await fillAndContinue(user);
    expect(await screen.findByText(copy.notLoggedIn.replace("{agent}", "Claude Code"))).toBeInTheDocument();
    await user.click(body().getByRole("button", { name: copy.connect }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe("ws://127.0.0.1:8788/agent-login?runtime=claude&profile=client-x");
  });

  it("drops the draft when the dialog closes without creating", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);
    await fillAndContinue(user);
    await screen.findByText(/Account confirmed/);
    rerender(<AddProfileDialog open={false} onOpenChange={() => {}} activeProfile={activeProfile} />);
    await waitFor(() => expect(discarded).toEqual(["client-x"]));
  });

  it("keeps the draft while the create runs, even if the dialog closes, and drops it only once that create failed", async () => {
    let release!: () => void;
    relay.createGate = new Promise((resolve) => (release = resolve));
    relay.createFails = true;
    const user = userEvent.setup();
    const { rerender } = render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);
    await fillAndContinue(user);
    await screen.findByText(/Account confirmed/);
    await user.click(body().getByRole("button", { name: en.common.create }));
    await waitFor(() => expect(createdWith).not.toBeNull());

    rerender(<AddProfileDialog open={false} onOpenChange={() => {}} activeProfile={activeProfile} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discarded).toEqual([]);

    release();
    await waitFor(() => expect(discarded).toEqual(["client-x"]));
  });

  it("keeps the custom home under Advanced: no draft, the home is checked and signed in instead, and no sharing choices", async () => {
    relay.loggedIn = false;
    const opened = stubWebSocket();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={() => {}} activeProfile={activeProfile} />);

    await user.click(body().getByRole("button", { name: copy.advanced }));
    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    expect(body().queryByText(copy.sharing.title)).not.toBeInTheDocument();
    await user.type(body().getByLabelText(copy.nameLabel), "Client X");
    await user.click(body().getByRole("button", { name: copy.continue }));

    await user.click(await body().findByRole("button", { name: copy.connect }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe(`ws://127.0.0.1:8788/agent-login?runtime=claude&home=${encodeURIComponent("/home/user/.anywh-client-x")}`);
    expect(fetchCalls().some(([url]) => url.endsWith("/control/profiles/draft"))).toBe(false);
  });

  it("with a custom home, offers the one-time copy and writes it into that home before closing", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    await user.click(body().getByRole("button", { name: copy.advanced }));
    await user.type(body().getByLabelText(copy.homeLabel), "/home/user/.anywh-client-x");
    expect(await body().findByText(copy.copyLabel)).toBeInTheDocument();
    expect(body().getByText("Files: 2 · MCP servers: 1")).toBeInTheDocument();
    expect(body().getByText("Settings naming a path that may not exist here: 1")).toBeInTheDocument();
    await user.type(body().getByLabelText(copy.nameLabel), "Client X");
    await user.click(body().getByRole("button", { name: copy.continue }));
    await screen.findByText(/Account confirmed/);
    await user.click(body().getByRole("button", { name: en.common.create }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(createdWith).toMatchObject({ label: "Client X", home: "/home/user/.anywh-client-x", runtimeId: "claude" });
    expect(createdWith?.draftId).toBeUndefined();
    expect(applied).toEqual({ home: "/home/user/.anywh-client-x", bundleFiles: 2 });
  });

  it("keeps the created profile and reports the failure when only the copy fails", async () => {
    relay.applyFails = true;
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AddProfileDialog open onOpenChange={onOpenChange} activeProfile={activeProfile} />);

    await fillAndContinue(user, "/home/user/.anywh-client-x");
    await screen.findByText(/Account confirmed/);
    await user.click(body().getByRole("button", { name: en.common.create }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(createdWith).not.toBeNull();
  });
});
