import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";

const { resolveConnectionMock } = vi.hoisted(() => ({ resolveConnectionMock: vi.fn() }));
vi.mock("@/lib/profiles/connectionResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/connectionResolver")>()),
  resolveConnection: resolveConnectionMock,
}));

import { fetchRawFile, listFiles } from "@/lib/relay/filesClient";

const profile: Profile = {
  id: "tailnet",
  label: "Tailnet",
  host: "127.0.0.1",
  relayPort: 0,
  tailnetAuthKey: "key",
  tailnetControlUrl: "https://headscale.test",
  tailnetTarget: "100.64.0.1:8765",
};

beforeEach(() => {
  resolveConnectionMock.mockReset().mockResolvedValue({ host: "127.0.0.1", port: 54321, token: "grant-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filesClient, resolved connection", () => {
  it("listFiles dials the resolved local address, with the token as an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ root: "/", path: "/", entries: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await listFiles(profile, "session-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54321/files/list?session=session-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer grant-token");
  });

  it("fetchRawFile fetches the bytes with the same Authorization header and hands back a Blob", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["bytes"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await fetchRawFile(profile, "session-1", "photo.png", 1000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54321/files/raw?session=session-1&path=photo.png&v=1000");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer grant-token");
    expect(blob).toBeInstanceOf(Blob);
  });

  it("fetchRawFile throws on a non-OK response instead of resolving a broken Blob", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(fetchRawFile(profile, "session-1", "photo.png", 1000)).rejects.toThrow(/401/);
  });
});
