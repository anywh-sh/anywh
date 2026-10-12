/**
 * The push-address registry's decisions, with no I/O: what a client may
 * register, when an entry expires, what the listing may reveal. A "push
 * device" here is one app installation's address at *this* relay — an
 * opaque `{gatewayUrl, pushKey}` pair somebody handed the client, plus a
 * blob the relay echoes back untouched. The relay never learns what the key
 * means or who issued it; see docs/push.md.
 */

export interface PushDevice {
  deviceId: string;
  gatewayUrl: string;
  pushKey: string;
  label?: string;
  /** Opaque to the relay, echoed to the gateway per notification. */
  data: Record<string, unknown>;
  /** Last successful PUT, ms since the epoch — what expiry is measured from. */
  updatedAt: number;
}

export interface PushDeviceInput {
  gatewayUrl: string;
  pushKey: string;
  label?: string;
  data: Record<string, unknown>;
}

/** A pusher nobody has re-registered in this long is dropped: the app
 * re-registers on launch, so silence means the install is gone. */
export const PUSH_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_GATEWAY_URL = 2048;
const MAX_PUSH_KEY = 256;
const MAX_LABEL = 64;
const MAX_DATA_BYTES = 512;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isValidDeviceId(id: string): boolean {
  return DEVICE_ID_PATTERN.test(id);
}

/** The gateway is called with the user's notification text, so it has to be
 * a TLS endpoint. Plain http is only accepted for a loopback address, which
 * is what a local gateway under test (or a self-hosted one on the same
 * machine) looks like. */
function isAcceptableGatewayUrl(raw: string): boolean {
  if (raw.length > MAX_GATEWAY_URL) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export type ParsedPushDevice = { ok: true; value: PushDeviceInput } | { ok: false };

/** Schema B of the push contract — the body of `PUT /push/devices/:deviceId`. */
export function parsePushDeviceBody(body: unknown): ParsedPushDevice {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const { gatewayUrl, pushKey, label, data } = body as Record<string, unknown>;
  if (typeof gatewayUrl !== "string" || !isAcceptableGatewayUrl(gatewayUrl)) return { ok: false };
  if (typeof pushKey !== "string" || pushKey.length === 0 || pushKey.length > MAX_PUSH_KEY) return { ok: false };
  if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL)) return { ok: false };
  if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) return { ok: false };
  const echoed = (data ?? {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(echoed)) > MAX_DATA_BYTES) return { ok: false };
  return { ok: true, value: { gatewayUrl, pushKey, ...(label !== undefined ? { label } : {}), data: echoed } };
}

export function upsertDevice(devices: readonly PushDevice[], deviceId: string, input: PushDeviceInput, now: number): PushDevice[] {
  const entry: PushDevice = { deviceId, ...input, updatedAt: now };
  return [...devices.filter((d) => d.deviceId !== deviceId), entry];
}

export function removeDevice(devices: readonly PushDevice[], deviceId: string): PushDevice[] {
  return devices.filter((d) => d.deviceId !== deviceId);
}

/** What the gateway's `rejected` list turns into: every entry holding a key
 * that is permanently dead, whichever device registered it. */
export function removePushKeys(devices: readonly PushDevice[], pushKeys: readonly string[]): PushDevice[] {
  const dead = new Set(pushKeys);
  return devices.filter((d) => !dead.has(d.pushKey));
}

export function pruneExpired(devices: readonly PushDevice[], now: number): PushDevice[] {
  return devices.filter((d) => now - d.updatedAt < PUSH_DEVICE_TTL_MS);
}

export interface PushDeviceListing {
  deviceId: string;
  label: string | null;
  lastSeenAt: number;
}

/** `GET /push/devices` — the key is a capability and never leaves the relay. */
export function listDevices(devices: readonly PushDevice[]): PushDeviceListing[] {
  return devices.map((d) => ({ deviceId: d.deviceId, label: d.label ?? null, lastSeenAt: d.updatedAt }));
}

/** Loose check for a file this relay wrote itself: anything that does not
 * look like an entry is dropped rather than trusted. */
export function sanitizeLoaded(raw: unknown): PushDevice[] {
  if (!Array.isArray(raw)) return [];
  const out: PushDevice[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { deviceId, updatedAt } = item as Record<string, unknown>;
    if (typeof deviceId !== "string" || !isValidDeviceId(deviceId) || typeof updatedAt !== "number") continue;
    const parsed = parsePushDeviceBody(item);
    if (!parsed.ok) continue;
    out.push({ deviceId, ...parsed.value, updatedAt });
  }
  return out;
}
