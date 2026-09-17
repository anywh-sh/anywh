import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSessions, renameSession } from "@/lib/relay/relayClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

// A tailnet connection needs a fresh connect token attached to every call
// (the proxy on the other side validates it on every TCP connection) —
// a direct-mode call (no token) must keep working exactly
// as before, with no stray Authorization header.
describe("relayClient HTTP helpers, connect token", () => {
  it("fetchSessions attaches an Authorization header when a token is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }))) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessions("127.0.0.1", 54321, "grant-token");

    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls[0];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer grant-token");
  });

  it("fetchSessions sends no Authorization header when no token is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }))) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await fetchSessions("127.0.0.1", 8765);

    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls[0];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  // A self-hosted install updates client and relay separately, so a relay
  // that predates `lastActiveAt` on `GET /sessions` is an ordinary state.
  // Normalizing it to `null` here is what keeps an `undefined` hiding behind
  // a `number` type out of the sidebar, where formatting one threw and took
  // the whole app down with it.
  it("fetchSessions normalizes a missing lastActiveAt to null", async () => {
    const body = JSON.stringify({ sessions: [{ id: "s-1", title: "Old relay" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)) as unknown);

    await expect(fetchSessions("127.0.0.1", 8765)).resolves.toEqual([
      { id: "s-1", title: "Old relay", lastActiveAt: null },
    ]);
  });

  it("fetchSessions keeps a lastActiveAt the relay did send", async () => {
    const body = JSON.stringify({ sessions: [{ id: "s-1", title: "New relay", lastActiveAt: 1_700_000_000_000 }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)) as unknown);

    await expect(fetchSessions("127.0.0.1", 8765)).resolves.toEqual([
      { id: "s-1", title: "New relay", lastActiveAt: 1_700_000_000_000 },
    ]);
  });

  it("renameSession merges the Authorization header with its own Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await renameSession("127.0.0.1", 54321, "session-1", "New title", "grant-token");

    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit | undefined][] } }).mock.calls[0];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer grant-token");
    expect(headers?.["Content-Type"]).toBe("application/json");
  });
});
