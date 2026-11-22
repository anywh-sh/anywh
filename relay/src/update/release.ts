// Pure helpers for the relay's self-update: release version parsing and the
// installer's porcelain progress lines. No I/O here.

/** What every manifest says in git, and so what a build from source reports:
 * "unknown", never a release to compare against or to update. Same value as
 * the client's `UNRELEASED_VERSION` (client/src/lib/install/appVersion.ts). */
export const UNRELEASED_VERSION = "0.0.0";

/** `1.2.3` or `v1.2.3` as numbers; null for anything else, including the
 * unreleased placeholder and pre-release suffixes (releases never carry one). */
export function parseRelease(raw: string): readonly [number, number, number] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(raw.trim());
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every((part) => part === 0) ? null : version;
}

/** Whether release `a` is strictly newer than release `b`; false when either
 * is not a release. */
export function isNewerRelease(a: string, b: string): boolean {
  const left = parseRelease(a);
  const right = parseRelease(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/** One `ANYWH ...` line of install-relay.sh's `--porcelain` output that the
 * updater cares about: the run's end, successful or not. */
export type InstallerOutcome = { readonly kind: "ok" } | { readonly kind: "fail"; readonly step: string; readonly code: string; readonly message: string };

export function parseInstallerLine(line: string): InstallerOutcome | null {
  if (/^ANYWH done ok(\s|$)/.test(line)) return { kind: "ok" };
  const fail = /^ANYWH fail (\S+) (\S+) ?(.*)$/.exec(line);
  if (fail) return { kind: "fail", step: fail[1], code: fail[2], message: fail[3] };
  return null;
}
