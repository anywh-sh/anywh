import { authHeaders, resolveConnection } from "@/lib/profiles/connectionResolver";
import type { Profile } from "@/lib/profiles/profiles";
import type { PushAddress } from "@/lib/platform/pushAddress";

/**
 * Registering this device's push address on each relay it uses (docs/push.md,
 * contract B). The decisions are pure and live up top; the effects (storage,
 * fetch) below are thin.
 */

/** A registration is repeated at most this often when nothing changed. */
export const REREGISTER_AFTER_MS = 24 * 60 * 60 * 1000;
const REGISTER_TIMEOUT_MS = 8_000;
const UNREGISTER_TIMEOUT_MS = 3_000;

/** Everything that, if it changes, makes the relay's copy wrong. */
export function registrationSignature(profile: Pick<Profile, "id" | "host" | "relayPort">, address: PushAddress): string {
  return JSON.stringify([address.gatewayUrl, address.pushKey, profile.id, profile.host, profile.relayPort]);
}

export interface RegistrationRecord {
  signature: string;
  /** When the relay last accepted it, ms. */
  at: number;
}

/** Whether to send the registration now: always when nothing is recorded or
 * what is recorded no longer matches; otherwise once a day, so a relay that
 * lost its copy (expiry, a new machine) gets it back without the person
 * doing anything. */
export function shouldRegister(record: RegistrationRecord | undefined, signature: string, now: number): boolean {
  if (!record || record.signature !== signature) return true;
  return now - record.at >= REREGISTER_AFTER_MS;
}

/** What a relay's answer to the registration means for this profile:
 * `active` — it will notify; `inactive` — it can't (a relay that predates
 * push, one with it disabled, or one that refused the body), so local
 * notifications stay; `unknown` — no verdict (the network, a 5xx), keep
 * whatever was believed. */
export type RegistrationOutcome = "active" | "inactive" | "unknown";

export function classifyRegistrationStatus(status: number): RegistrationOutcome {
  if (status >= 200 && status < 300) return "active";
  if (status === 404 || status === 426 || status === 400) return "inactive";
  return "unknown";
}

const DEVICE_ID_KEY = "anywh:push-device-id";
const RECORDS_KEY = "anywh:push-registrations";

/** A stable per-install id: a relay keeps one entry per id, so a restart of
 * the app re-registers over its own entry instead of adding another. */
export function readOrCreateDeviceId(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string {
  const existing = storage.getItem(DEVICE_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const created = crypto.randomUUID();
  storage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function readRecords(): Record<string, RegistrationRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, RegistrationRecord>) : {};
  } catch {
    return {};
  }
}

function writeRecord(profileId: string, record: RegistrationRecord | null): void {
  const records = readRecords();
  if (record) records[profileId] = record;
  else delete records[profileId];
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
}

// Whether push is working for a profile, as far as the last registration
// said. Not persisted on its own: it is derived from the records, so a launch
// that skips re-registering (done within the day) still starts out knowing.
const active = new Map<string, boolean>();
const activeListeners = new Set<() => void>();

function setActive(profileId: string, value: boolean): void {
  if ((active.get(profileId) ?? false) === value) return;
  active.set(profileId, value);
  for (const listener of activeListeners) listener();
}

/** Whether a registration was ever accepted for this profile and not taken
 * back since. */
export function hasRegistration(profileId: string): boolean {
  return profileId in readRecords();
}

export function isPushActive(profileId: string): boolean {
  return active.get(profileId) ?? false;
}

export function subscribePushActive(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

/** Registers `address` on one profile's relay, unless it already holds it
 * (see `shouldRegister`). */
export async function ensureRegistered(profile: Profile, address: PushAddress, now: number = Date.now()): Promise<void> {
  const signature = registrationSignature(profile, address);
  const record = readRecords()[profile.id];
  if (!shouldRegister(record, signature, now)) {
    setActive(profile.id, true);
    return;
  }

  let outcome: RegistrationOutcome = "unknown";
  try {
    const connection = await resolveConnection(profile);
    const response = await fetch(`http://${connection.host}:${connection.port}/push/devices/${encodeURIComponent(readOrCreateDeviceId())}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(connection.token) },
      body: JSON.stringify({ gatewayUrl: address.gatewayUrl, pushKey: address.pushKey, data: { profileId: profile.id } }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    outcome = classifyRegistrationStatus(response.status);
  } catch (error) {
    console.error(`push: could not register on ${profile.id}:`, error);
  }

  if (outcome === "active") {
    writeRecord(profile.id, { signature, at: now });
    setActive(profile.id, true);
  } else if (outcome === "inactive") {
    writeRecord(profile.id, null);
    setActive(profile.id, false);
  }
}

/** Takes this device's address off one relay, best effort: a relay that can't
 * be reached has nothing to gain from us and its copy expires on its own, and
 * the gateway stops honouring the key at the source in any case. */
export async function unregister(profile: Profile): Promise<void> {
  writeRecord(profile.id, null);
  setActive(profile.id, false);
  try {
    const connection = await resolveConnection(profile);
    await fetch(`http://${connection.host}:${connection.port}/push/devices/${encodeURIComponent(readOrCreateDeviceId())}`, {
      method: "DELETE",
      headers: authHeaders(connection.token),
      signal: AbortSignal.timeout(UNREGISTER_TIMEOUT_MS),
    });
  } catch {
    // Best effort, see above.
  }
}

/** Test seam: forgets everything this module holds in memory. */
export function resetPushRegistrationForTests(): void {
  active.clear();
}
