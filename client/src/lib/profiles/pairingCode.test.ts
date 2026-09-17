import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverPairingEndpoints, parsePairingCode, WELL_KNOWN_PAIRING_PATH } from "./pairingCode";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePairingCode", () => {
  it("splits a well-formed code into its join code and origin", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@example.com")).toEqual({
      joinCode: "ABCDEF-GHJKMNPQ",
      origin: "https://example.com",
    });
  });

  it("keeps an explicit port", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@example.com:8787")?.origin).toBe("https://example.com:8787");
  });

  it("tolerates how a code actually gets pasted — surrounding space, lowercase, an explicit scheme", () => {
    expect(parsePairingCode("  abcdef-ghjkmnpq@https://example.com  ")).toEqual({
      joinCode: "ABCDEF-GHJKMNPQ",
      origin: "https://example.com",
    });
  });

  it("upgrades a non-loopback http host to https — the code and this device's public key both cross that wire", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@http://example.com")?.origin).toBe("https://example.com");
  });

  it("leaves loopback on http, so a self-hoster can pair against a relay on this same machine", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@http://localhost:8787")?.origin).toBe("http://localhost:8787");
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@http://127.0.0.1:8787")?.origin).toBe("http://127.0.0.1:8787");
  });

  it("splits at the last @, so a code containing one still resolves the right host", () => {
    expect(parsePairingCode("AB@CD-EFGH@example.com")).toEqual({
      joinCode: "AB@CD-EFGH",
      origin: "https://example.com",
    });
  });

  it("rejects anything that isn't code@host", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ")).toBeNull();
    expect(parsePairingCode("@example.com")).toBeNull();
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@")).toBeNull();
    expect(parsePairingCode("")).toBeNull();
  });

  it("rejects a host half that carries more than a host — a mangled paste, not intent", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@example.com/v1/nodes/claim")).toBeNull();
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@example.com?x=1")).toBeNull();
  });

  it("can't be tricked into resolving a host out of embedded credentials — the last @ still wins", () => {
    // Not a rejection but not a vulnerability either: the credentials land
    // in the code half, so the origin is still the real host and the only
    // casualty is a code that won't redeem.
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@user:pw@example.com")?.origin).toBe("https://example.com");
  });

  it("rejects a non-http(s) scheme", () => {
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@ftp://example.com")).toBeNull();
    expect(parsePairingCode("ABCDEF-GHJKMNPQ@javascript:alert(1)")).toBeNull();
  });

  it("rejects internal whitespace on either half", () => {
    expect(parsePairingCode("ABC DEF@example.com")).toBeNull();
    expect(parsePairingCode("ABCDEF@exa mple.com")).toBeNull();
  });
});

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 404),
      json: () => Promise.resolve(response.body),
    } as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("discoverPairingEndpoints", () => {
  it("reads claimUrl and brokerUrl from the host's own discovery document", async () => {
    const fetchMock = stubFetch({
      ok: true,
      body: { claimUrl: "https://api.example.com/v1/nodes/claim", brokerUrl: "https://api.example.com/v1/connect/w1" },
    });

    await expect(discoverPairingEndpoints("https://example.com")).resolves.toEqual({
      claimUrl: "https://api.example.com/v1/nodes/claim",
      brokerUrl: "https://api.example.com/v1/connect/w1",
    });
    expect(fetchMock).toHaveBeenCalledWith(`https://example.com${WELL_KNOWN_PAIRING_PATH}`, expect.anything());
  });

  it("accepts a document with no brokerUrl — the claim response can still name one", async () => {
    stubFetch({ ok: true, body: { claimUrl: "https://api.example.com/v1/nodes/claim" } });
    await expect(discoverPairingEndpoints("https://example.com")).resolves.toEqual({
      claimUrl: "https://api.example.com/v1/nodes/claim",
      brokerUrl: undefined,
    });
  });

  it("ignores fields it doesn't know, same tolerance as the claim response", async () => {
    stubFetch({ ok: true, body: { claimUrl: "https://api.example.com/claim", somethingElse: 42 } });
    await expect(discoverPairingEndpoints("https://example.com")).resolves.toEqual({
      claimUrl: "https://api.example.com/claim",
      brokerUrl: undefined,
    });
  });

  it("throws when the host publishes no document at all — a host that isn't pairable should say so", async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(discoverPairingEndpoints("https://example.com")).rejects.toThrow(/discovery failed \(404\)/);
  });

  it("throws when the document has no claimUrl", async () => {
    stubFetch({ ok: true, body: { brokerUrl: "https://api.example.com/connect" } });
    await expect(discoverPairingEndpoints("https://example.com")).rejects.toThrow(/no claimUrl/);
  });

  it("rejects a non-https URL in the document — otherwise the scheme check on the typed host means nothing", async () => {
    stubFetch({ ok: true, body: { claimUrl: "http://api.example.com/claim" } });
    await expect(discoverPairingEndpoints("https://example.com")).rejects.toThrow(/non-https claimUrl/);
  });

  it("still allows a loopback http URL in the document, matching parsePairingCode's own carve-out", async () => {
    stubFetch({ ok: true, body: { claimUrl: "http://127.0.0.1:8787/claim" } });
    await expect(discoverPairingEndpoints("http://127.0.0.1:8787")).resolves.toEqual({
      claimUrl: "http://127.0.0.1:8787/claim",
      brokerUrl: undefined,
    });
  });

  it("rejects a malformed URL in the document", async () => {
    stubFetch({ ok: true, body: { claimUrl: "not a url" } });
    await expect(discoverPairingEndpoints("https://example.com")).rejects.toThrow(/malformed claimUrl/);
  });
});
