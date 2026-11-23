import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANUAL_UPGRADE_COMMAND, resetLegacyRelayUpgrades, useLegacyRelayUpgrade } from "@/hooks/relay/useLegacyRelayUpgrade";
import { UPGRADE_EXIT_MARKER } from "@/lib/relay/legacyRelayUpgrade";
import type { Profile } from "@/lib/profiles/profiles";

// The old relay is the network edge: `fetch` answers its HTTP routes and a
// fake `WebSocket` stands in for its conversations (`turn_state`) and its
// terminal (what the update command prints).
interface FakeRelay {
  version: string;
  /** Conversation ids with a turn in flight. */
  busy: Set<string>;
  /** What the terminal prints once the command is typed. */
  terminalOutput: string;
  /** Version the relay reports once the command has run. */
  versionAfter: string;
  commands: string[];
}
let relay: FakeRelay;

class FakeSocket {
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    setTimeout(() => this.open(), 0);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  private emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  private open(): void {
    const url = new URL(this.url);
    if (url.pathname === "/terminal") {
      this.emit("open");
      this.emit("message", JSON.stringify({ type: "data", data: "$ " }));
      return;
    }
    const session = url.searchParams.get("session") ?? "";
    this.emit("message", JSON.stringify({ type: "turn_state", active: relay.busy.has(session) }));
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as { type: string; data: string };
    if (message.type !== "input") return;
    relay.commands.push(message.data);
    relay.version = relay.versionAfter;
    setTimeout(() => this.emit("message", JSON.stringify({ type: "data", data: relay.terminalOutput })), 0);
  }
  close(): void {}
}

const profile: Profile = { id: "home", label: "Home", host: "100.64.0.5", relayPort: 8765 };
const fast = { busyPollMs: 5, busyTimeoutMs: 2000, versionPollMs: 5, restartTimeoutMs: 200 };

beforeEach(() => {
  resetLegacyRelayUpgrades();
  relay = { version: "0.2.40", busy: new Set(), terminalOutput: `ANYWH done ok\r\n${UPGRADE_EXIT_MARKER}=0\r\n`, versionAfter: "0.2.50", commands: [] };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const path = new URL(input).pathname;
      if (path === "/host-info") return Promise.resolve(new Response(JSON.stringify({ hostname: "h", platform: "linux", editor: null, version: relay.version, features: ["bots"] })));
      if (path === "/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [{ id: "s1", title: "a", lastActiveAt: Date.now() }] })));
      return Promise.resolve(new Response("{}"));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(timing: Partial<typeof fast> = {}) {
  return renderHook(() => useLegacyRelayUpgrade(profile, { appVersion: "0.2.50", timing: { ...fast, ...timing } }));
}

describe("useLegacyRelayUpgrade", () => {
  it("is offered for an older relay that cannot update itself, and runs it to done", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    expect(result.current.relayVersion).toBe("0.2.40");
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    expect(relay.commands).toHaveLength(1);
    expect(relay.commands[0]).toContain("--version v0.2.50");
  });

  it("waits while a conversation has a turn running, then updates", async () => {
    relay.busy.add("s1");
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toEqual({ phase: "waiting", busy: 1 }));
    expect(relay.commands).toEqual([]);
    relay.busy.clear();
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
  });

  it("gives up waiting after its limit, without touching the relay", async () => {
    relay.busy.add("s1");
    const { result } = mount({ busyTimeoutMs: 30 });
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toMatchObject({ phase: "failed", reason: "still_busy", command: MANUAL_UPGRADE_COMMAND }));
    expect(relay.commands).toEqual([]);
  });

  it("closing the notice while it waits calls the run off, and keeps the update offered elsewhere", async () => {
    relay.busy.add("s1");
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"));
    act(() => result.current.dismiss());
    relay.busy.clear();
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.noticeDismissed).toBe(true);
    // Settings and the bots section still show the button.
    expect(result.current.state.phase).toBe("available");
    expect(relay.commands).toEqual([]);
  });

  it("starting again after calling it off runs once: the called-off run never wakes up to type too", async () => {
    relay.busy.add("s1");
    const { result } = mount({ busyPollMs: 40 });
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"));
    act(() => result.current.dismiss());
    relay.busy.clear();
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.phase).toBe("done"));
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.commands).toHaveLength(1);
    expect(result.current.noticeDismissed).toBe(false);
  });

  it("a profile edited to point at a relay that needs nothing drops the offer instead of running it there", async () => {
    let target: Profile = profile;
    const { result, rerender } = renderHook(() => useLegacyRelayUpgrade(target, { appVersion: "0.2.50", timing: fast }));
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    // Same profile, now another machine whose relay is ahead of the app.
    relay.version = "0.2.60";
    target = { ...profile, host: "100.64.0.9" };
    rerender();
    await waitFor(() => expect(result.current.state.phase).toBe("hidden"));
    expect(result.current.relayVersion).toBeUndefined();
  });

  it("a machine with no relay installed from a release says so", async () => {
    relay.terminalOutput = `ANYWH fail check not_installed no running relay\r\n${UPGRADE_EXIT_MARKER}=3\r\n`;
    relay.versionAfter = "0.2.40";
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toMatchObject({ phase: "failed", reason: "not_installed" }));
  });

  it("an installer that stops reports its own words", async () => {
    relay.terminalOutput = `ANYWH fail download checksum_mismatch checksum mismatch for a.tar.gz\r\n${UPGRADE_EXIT_MARKER}=1\r\n`;
    relay.versionAfter = "0.2.40";
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toMatchObject({ phase: "failed", reason: "installer", detail: "checksum mismatch for a.tar.gz" }));
  });

  it("a relay that never comes back on the new version is reported, not called done", async () => {
    relay.versionAfter = "0.2.40";
    const { result } = mount();
    await waitFor(() => expect(result.current.state.phase).toBe("available"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toMatchObject({ phase: "failed", reason: "not_back" }));
  });

  it("every place showing it shares one run: a second start does nothing while it runs", async () => {
    relay.busy.add("s1");
    const first = mount();
    const second = mount();
    await waitFor(() => expect(first.result.current.state.phase).toBe("available"));
    act(() => first.result.current.start());
    await waitFor(() => expect(second.result.current.state.phase).toBe("waiting"));
    act(() => second.result.current.start());
    relay.busy.clear();
    await waitFor(() => expect(second.result.current.state.phase).toBe("done"));
    expect(relay.commands).toHaveLength(1);
  });
});
