// Kimi Code's plan usage, as its own CLI serves it: the local `kimi web`
// server answers `GET /api/v1/oauth/usage` and `GET /api/v1/oauth/userinfo`
// with the logged-in account's quota and level, reading them with the CLI's
// own login (the relay never touches Kimi's credentials). Pure parsing of
// those two bodies; the process is `probes/kimiUsage.ts`.
//
// Shapes measured against Kimi Code CLI 2.6.0:
//   usage, logged in:  {code: 0, data: {kind: "ok", quota: {usages: {
//                        limit5h: {usedRatio, resetAt}, monthTotal: {…},
//                        monthCode: {…}}, extraUsage: null}}}
//   either, logged out: {code: 0, data: {kind: "error", message:
//                        'No token for "kimi-code". Run /login to authenticate.'}}
//   userinfo, logged in: {data: {kind: "ok", userInfo: {userId,
//                        userLevelName: "Plus", …e-mail, nickname…}}}
// `limit7d` exists in the CLI's own parser but was absent on the plan
// measured; it is read when present.
import { PLAN_WINDOW_MINS, type PlanLabel, type PlanWindow } from "./types.js";
import { clampPercent, isRecord, sortWindows } from "./windows.js";

/** The quota windows the CLI reports, by its own key. `monthCode` (the
 * coding share of the month) is left out: it is a slice of `monthTotal`,
 * with the same reset, and two windows of one length would read as two
 * limits. */
const WINDOW_KEYS: readonly { readonly key: string; readonly durationMins: number }[] = [
  { key: "limit5h", durationMins: PLAN_WINDOW_MINS.fiveHour },
  { key: "limit7d", durationMins: PLAN_WINDOW_MINS.sevenDay },
  { key: "monthTotal", durationMins: PLAN_WINDOW_MINS.thirtyDay },
];

export type KimiUsageParse =
  | { kind: "reading"; windows: PlanWindow[]; status: "ok" | "limited" }
  | { kind: "signed_out" }
  | { kind: "unrecognized" };

/** `data.kind: "error"` that is about the login, not the server. */
const SIGNED_OUT = /no token|run \/login|authenticat|unauthori|not logged in/i;

function dataOf(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body.data) ? body.data : undefined;
}

function window(raw: unknown, durationMins: number): PlanWindow | undefined {
  if (!isRecord(raw) || typeof raw.usedRatio !== "number" || !Number.isFinite(raw.usedRatio)) return undefined;
  const usedPercent = clampPercent(raw.usedRatio * 100);
  if (usedPercent === null) return undefined;
  const resetsAt = typeof raw.resetAt === "string" ? Date.parse(raw.resetAt) : Number.NaN;
  return { durationMins, usedPercent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

/** The usage route's body. A body of another shape is `unrecognized`, never
 * a guess at zero usage. */
export function parseKimiUsage(body: unknown): KimiUsageParse {
  const data = dataOf(body);
  if (!data) return { kind: "unrecognized" };
  if (data.kind === "error") return typeof data.message === "string" && SIGNED_OUT.test(data.message) ? { kind: "signed_out" } : { kind: "unrecognized" };
  if (data.kind !== "ok" || !isRecord(data.quota) || !isRecord(data.quota.usages)) return { kind: "unrecognized" };
  const usages = data.quota.usages;
  const windows = WINDOW_KEYS.flatMap(({ key, durationMins }) => {
    const parsed = window(usages[key], durationMins);
    return parsed ? [parsed] : [];
  });
  if (windows.length === 0) return { kind: "unrecognized" };
  const status = windows.some((entry) => entry.usedPercent >= 100) ? "limited" : "ok";
  return { kind: "reading", windows: sortWindows(windows), status };
}

/** What the userinfo route says about the account: its level, as the
 * plan chip, and its user id — an identifier for the account key only,
 * never stored, logged or sent. Everything else it carries (e-mail,
 * nickname, avatar) is never read. */
export interface KimiAccount {
  readonly plan?: PlanLabel;
  readonly userId?: string;
}

export function parseKimiUserInfo(body: unknown): KimiAccount {
  const data = dataOf(body);
  if (!data || data.kind !== "ok" || !isRecord(data.userInfo)) return {};
  const { userLevelName, userId } = data.userInfo;
  const level = typeof userLevelName === "string" ? userLevelName.trim() : "";
  return {
    ...(level ? { plan: { family: level.toLowerCase(), label: level } } : {}),
    ...(typeof userId === "string" && userId.trim() !== "" ? { userId: userId.trim() } : {}),
  };
}

/** The bearer token `kimi web` prints when it is ready ("Token:    <t>"). */
export function kimiWebToken(stdout: string): string | undefined {
  return /^\s*Token:\s+(\S+)\s*$/m.exec(stdout)?.[1];
}
