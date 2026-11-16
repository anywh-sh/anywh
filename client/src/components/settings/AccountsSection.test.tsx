import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsSection } from "./AccountsSection";
import { publishPlanUsage } from "@/lib/planUsage/signedOutAgents";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";

vi.mock("@/lib/telemetry/instrument", () => ({ trackFeature: vi.fn(), trackError: vi.fn() }));

// `fetch` and the socket are the network edge, stubbed; the section and the
// dialog it opens are real.

const copy = en.settings.profile.accounts;
const profile: Profile = { id: "work", label: "Work", host: "100.64.0.7", relayPort: 8790 };

const agents = [
  { id: "claude", bin: "claude", installed: true, version: "2.1.323", loggedIn: true, account: "me@example.com", plan: "max", signIn: true, signOut: true },
  { id: "codex", bin: "codex", installed: true, version: "0.154.0", loggedIn: false, account: null, plan: null, signIn: true, signOut: true },
  { id: "kimi", bin: "kimi", installed: false, version: null, loggedIn: null, account: null, plan: null, signIn: true, signOut: false },
];

class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send() {}
  close() {
    this.onclose?.();
  }
}

let fetchMock: ReturnType<typeof vi.fn<() => Promise<Response>>>;

beforeEach(() => {
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  fetchMock = vi.fn<() => Promise<Response>>(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ agents }) } as Response));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const body = () => within(document.body);

describe("AccountsSection", () => {
  it("lists each installed agent with the account it is signed in to", async () => {
    render(<AccountsSection profile={profile} />);
    expect(await body().findByText("Connected as me@example.com · max")).toBeInTheDocument();
    expect(body().getByText(copy.signedOut)).toBeInTheDocument();
    expect(body().queryByText("Kimi Code")).not.toBeInTheDocument();
    expect(body().getByRole("button", { name: copy.switchAccount })).toBeInTheDocument();
    expect(body().getByRole("button", { name: copy.connect })).toBeInTheDocument();
  });

  it("Connect opens the sign-in for that agent on this profile's machine", async () => {
    const user = userEvent.setup();
    render(<AccountsSection profile={profile} />);
    await user.click(await body().findByRole("button", { name: copy.connect }));
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    expect(FakeSocket.opened[0].url).toBe("ws://100.64.0.7:8790/agent-login?runtime=codex");
  });

  it("re-reads the accounts once a sign-in lands", async () => {
    const user = userEvent.setup();
    render(<AccountsSection profile={profile} />);
    await user.click(await body().findByRole("button", { name: copy.connect }));
    await waitFor(() => expect(FakeSocket.opened).toHaveLength(1));
    const reads = fetchMock.mock.calls.length;
    FakeSocket.opened[0].onmessage?.({ data: JSON.stringify({ type: "done", account: "work@example.com" }) });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(reads + 1));
  });

  it("Disconnect is offered only for a signed-in agent, and signs it out after a confirmation", async () => {
    const user = userEvent.setup();
    render(<AccountsSection profile={profile} />);
    const disconnect = await body().findByRole("button", { name: copy.disconnect });
    expect(body().getAllByRole("button", { name: copy.disconnect })).toHaveLength(1);
    await user.click(disconnect);
    const dialog = await body().findByRole("dialog");
    expect(dialog).toHaveTextContent("Disconnect Claude Code?");
    const reads = fetchMock.mock.calls.length;
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ loggedIn: false }) } as Response));
    await user.click(within(dialog).getByRole("button", { name: copy.disconnect }));
    await waitFor(() => expect(body().queryByRole("dialog")).not.toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toContain("http://100.64.0.7:8790/control/agents/claude/logout");
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(reads + 1));
  });

  it("a sign-out the relay couldn't do says so, and keeps the confirmation open", async () => {
    const user = userEvent.setup();
    render(<AccountsSection profile={profile} />);
    await user.click(await body().findByRole("button", { name: copy.disconnect }));
    const dialog = await body().findByRole("dialog");
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as Response));
    await user.click(within(dialog).getByRole("button", { name: copy.disconnect }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(copy.disconnectFailed);
  });

  it("reopened, it shows the accounts it last read at once, and re-reads them in the background", async () => {
    const home: Profile = { ...profile, id: "cached" };
    const first = render(<AccountsSection profile={home} />);
    await body().findByText("Connected as me@example.com · max");
    first.unmount();
    // The relay is slow to answer now: what was read before shows meanwhile.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<AccountsSection profile={home} />);
    expect(body().getByText("Connected as me@example.com · max")).toBeInTheDocument();
    expect(body().queryByText(copy.loading)).not.toBeInTheDocument();
  });

  it("with nothing cached, opens on the logins plan usage already knows", () => {
    const fresh: Profile = { ...profile, id: "fresh" };
    publishPlanUsage({
      fresh: {
        connection: "live",
        runtimes: [
          { runtime: "claude", status: "ok", windows: [], observedAt: 1, plan: { family: "max", label: "Max 5x" } },
          { runtime: "codex", status: "signed_out", windows: [], observedAt: 1 },
        ],
        observedAt: 1,
        receivedAt: 1,
        refreshing: false,
      },
    });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<AccountsSection profile={fresh} />);
    expect(body().getByText("Connected · Max 5x")).toBeInTheDocument();
    expect(body().getByText(copy.signedOut)).toBeInTheDocument();
    expect(body().queryByText(copy.loading)).not.toBeInTheDocument();
    publishPlanUsage({});
  });

  it("says so when the machine can't be reached", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<AccountsSection profile={{ ...profile, id: "offline" }} />);
    expect(await body().findByText(copy.unreachable)).toBeInTheDocument();
  });
});
