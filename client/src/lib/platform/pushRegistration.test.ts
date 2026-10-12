import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/profiles/profiles";
import {
  classifyRegistrationStatus,
  ensureRegistered,
  hasRegistration,
  isPushActive,
  readOrCreateDeviceId,
  REREGISTER_AFTER_MS,
  registrationSignature,
  resetPushRegistrationForTests,
  shouldRegister,
  subscribePushActive,
  unregister,
} from "./pushRegistration";

const address = { gatewayUrl: "https://gw.example.test/push/v1/notify", pushKey: "key-1" };
const profile: Profile = { id: "pessoal", label: "Pessoal", host: "100.64.0.9", relayPort: 8765, connectToken: "tok" };

describe("registrationSignature / shouldRegister", () => {
  it("changes with the address and with where the relay is, not with the label", () => {
    const base = registrationSignature(profile, address);
    const renamed: Profile = { ...profile, label: "Renamed" };
    expect(registrationSignature(renamed, address)).toBe(base);
    expect(registrationSignature(profile, { ...address, pushKey: "key-2" })).not.toBe(base);
    expect(registrationSignature(profile, { ...address, gatewayUrl: "https://other.test/n" })).not.toBe(base);
    expect(registrationSignature({ ...profile, host: "100.64.0.10" }, address)).not.toBe(base);
    expect(registrationSignature({ ...profile, relayPort: 9000 }, address)).not.toBe(base);
  });

  it("registers when nothing is recorded or the record is stale, and otherwise once a day", () => {
    const signature = registrationSignature(profile, address);
    const now = 10 * REREGISTER_AFTER_MS;
    expect(shouldRegister(undefined, signature, now)).toBe(true);
    expect(shouldRegister({ signature: "other", at: now }, signature, now)).toBe(true);
    expect(shouldRegister({ signature, at: now - REREGISTER_AFTER_MS + 1 }, signature, now)).toBe(false);
    expect(shouldRegister({ signature, at: now - REREGISTER_AFTER_MS }, signature, now)).toBe(true);
  });
});

describe("classifyRegistrationStatus", () => {
  it("reads success as active, a relay without push as inactive, and the rest as no verdict", () => {
    expect(classifyRegistrationStatus(204)).toBe("active");
    expect(classifyRegistrationStatus(200)).toBe("active");
    for (const status of [404, 426, 400]) expect(classifyRegistrationStatus(status)).toBe("inactive");
    for (const status of [500, 502, 503, 429, 401]) expect(classifyRegistrationStatus(status)).toBe("unknown");
  });
});

describe("readOrCreateDeviceId", () => {
  it("creates one id and keeps it, and replaces a stored value that is not a usable id", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const first = readOrCreateDeviceId(storage);
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(readOrCreateDeviceId(storage)).toBe(first);
    store.set("anywh:push-device-id", "bad id!");
    expect(readOrCreateDeviceId(storage)).not.toBe("bad id!");
  });
});

describe("registering on a relay", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    resetPushRegistrationForTests();
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the address with this profile's id as the echoed data, under the device id, with the profile's token", async () => {
    await ensureRegistered(profile, address);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://100.64.0.9:8765/push/devices/${readOrCreateDeviceId()}`);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ gatewayUrl: address.gatewayUrl, pushKey: "key-1", data: { profileId: "pessoal" } });
    expect(isPushActive("pessoal")).toBe(true);
    expect(hasRegistration("pessoal")).toBe(true);
  });

  it("doesn't repeat itself within the day, but does when the address changes or a day has passed", async () => {
    const t0 = 1_000_000;
    await ensureRegistered(profile, address, t0);
    await ensureRegistered(profile, address, t0 + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await ensureRegistered(profile, { ...address, pushKey: "key-2" }, t0 + 2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await ensureRegistered(profile, { ...address, pushKey: "key-2" }, t0 + 2000 + REREGISTER_AFTER_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a launch inside the day still knows push is active without asking the relay again", async () => {
    await ensureRegistered(profile, address, 5000);
    resetPushRegistrationForTests(); // a new launch: in-memory state is gone, the record is not
    expect(isPushActive("pessoal")).toBe(false);
    await ensureRegistered(profile, address, 6000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isPushActive("pessoal")).toBe(true);
  });

  it("a relay without push (404 or 426) leaves it inactive and forgets any earlier acceptance", async () => {
    await ensureRegistered(profile, address, 1);
    expect(isPushActive("pessoal")).toBe(true);

    fetchMock.mockResolvedValue(new Response(null, { status: 426 }));
    await ensureRegistered(profile, { ...address, pushKey: "key-2" }, 2);
    expect(isPushActive("pessoal")).toBe(false);
    expect(hasRegistration("pessoal")).toBe(false);
  });

  it("an unreachable relay or a 503 changes nothing: no verdict", async () => {
    await ensureRegistered(profile, address, 1);
    fetchMock.mockRejectedValue(new TypeError("network down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ensureRegistered(profile, { ...address, pushKey: "key-2" }, 2);
    expect(isPushActive("pessoal")).toBe(true);

    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 503 }));
    await ensureRegistered(profile, { ...address, pushKey: "key-3" }, 3);
    expect(isPushActive("pessoal")).toBe(true);
  });

  it("tells subscribers when a profile's state flips, and not when it stays the same", async () => {
    const listener = vi.fn();
    const stop = subscribePushActive(listener);
    await ensureRegistered(profile, address, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    await ensureRegistered(profile, { ...address, pushKey: "key-2" }, 2);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("unregister DELETEs under the same device id, forgets the record, and swallows a relay that can't be reached", async () => {
    await ensureRegistered(profile, address);
    fetchMock.mockClear().mockRejectedValue(new TypeError("gone"));

    await expect(unregister(profile)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://100.64.0.9:8765/push/devices/${readOrCreateDeviceId()}`);
    expect(init.method).toBe("DELETE");
    expect(hasRegistration("pessoal")).toBe(false);
    expect(isPushActive("pessoal")).toBe(false);
  });
});
