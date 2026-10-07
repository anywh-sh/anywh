/**
 * The decisions behind delivering a notification to gateways, with no I/O:
 * who gets it, how a gateway's answer is read, when to try again. The
 * effectful half is dispatcher.ts. Contract C of docs/push.md.
 */
import type { PushDevice } from "./pushDevices.js";

/** What a gateway is asked to deliver to. The gateway only ever sees the key
 * and the opaque blob the client attached to it. */
export interface GatewayTarget {
  pushKey: string;
  data: Record<string, unknown>;
}

/** Devices to notify, grouped by the gateway that serves them: one request
 * per gateway, however many phones it fronts. The same key registered twice
 * with the same blob (a reinstall under a new device id) is asked once. */
export function groupByGateway(devices: readonly PushDevice[]): Map<string, GatewayTarget[]> {
  const groups = new Map<string, GatewayTarget[]>();
  for (const device of devices) {
    const targets = groups.get(device.gatewayUrl) ?? [];
    const signature = JSON.stringify([device.pushKey, device.data]);
    if (!targets.some((t) => JSON.stringify([t.pushKey, t.data]) === signature)) {
      targets.push({ pushKey: device.pushKey, data: device.data });
    }
    groups.set(device.gatewayUrl, targets);
  }
  return groups;
}

/** What to do after one attempt at one gateway. */
export type AttemptOutcome =
  /** Delivered, except for `rejected` keys (permanently dead — forget them)
   * and `failed` ones (worth another try, alone). */
  | { kind: "answered"; rejected: string[]; failed: string[] }
  /** The whole request should be repeated, no sooner than `afterMs` when the
   * gateway said so (429 / 5xx / unreachable). */
  | { kind: "retry"; afterMs?: number }
  /** The gateway refused the request itself (400-class): repeating the same
   * bytes will get the same answer. */
  | { kind: "drop"; reason: string };

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `Retry-After` as seconds or an HTTP date, in ms; `undefined` when absent
 * or unusable. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  if (/^\d+(\.\d+)?$/.test(header.trim())) return Math.round(Number(header) * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Reads a gateway's HTTP answer. `body` is the parsed JSON, or `undefined`
 * when there was none; `status` is `null` when no answer came at all. */
export function interpretResponse(status: number | null, body: unknown, retryAfter: string | null | undefined, now: number): AttemptOutcome {
  if (status === null) return { kind: "retry" };
  if (status === 200) {
    const parsed = (typeof body === "object" && body !== null ? body : {}) as { rejected?: unknown; failed?: unknown };
    return { kind: "answered", rejected: stringArray(parsed.rejected), failed: stringArray(parsed.failed) };
  }
  if (status === 429 || status >= 500) return { kind: "retry", afterMs: parseRetryAfter(retryAfter, now) };
  return { kind: "drop", reason: `gateway answered ${status}` };
}

/** Attempts per request, the first included. With the backoff below that is
 * about half a minute of retrying — a phone buzzing late is better than not,
 * a phone buzzing a quarter of an hour later is noise. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 2000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Delay before attempt `attempt + 1` (`attempt` counts the ones already
 * made, starting at 1): 2 s, 4 s, 8 s, 16 s, each shortened by up to half at
 * random so a gateway coming back is not met by every relay at once. A
 * gateway's own `Retry-After` wins when it asks for longer, capped so a
 * hostile value can't park a notification for hours. */
export function nextDelayMs(attempt: number, random: number, retryAfterMs?: number): number {
  const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) * (1 - random * 0.5);
  return Math.max(backoff, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
}
