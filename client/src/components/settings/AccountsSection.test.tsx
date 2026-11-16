import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsSection } from "./AccountsSection";
import { en } from "@/i18n/en";
import type { Profile } from "@/lib/profiles/profiles";

vi.mock("@/lib/telemetry/instrument", () => ({ trackFeature: vi.fn(), trackError: vi.fn() }));

// `fetch` and the socket are the network edge, stubbed; the section and the
// dialog it opens are real.

const copy = en.settings.profile.accounts;
const profile: Profile = { id: "work", label: "Work", host: "100.64.0.7", relayPort: 8790 };

const agents = [
  { id: "claude", bin: "claude", installed: true, version: "2.1.323", loggedIn: true, account: "me@example.com", plan: "max", signIn: true },
  { id: "codex", bin: "codex", installed: true, version: "0.154.0", loggedIn: false, account: null, plan: null, signIn: true },
  { id: "kimi", bin: "kimi", installed: false, version: null, loggedIn: null, account: null, plan: null, signIn: true },
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

  it("says so when the machine can't be reached", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<AccountsSection profile={profile} />);
    expect(await body().findByText(copy.unreachable)).toBeInTheDocument();
  });
});
