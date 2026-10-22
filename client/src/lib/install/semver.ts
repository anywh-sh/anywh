/**
 * MAJOR.MINOR.PATCH with an optional `v` prefix (GitHub tags carry one) and
 * an optional `-prerelease` suffix, ordered the SemVer way: a prerelease
 * sorts below its release (`0.2.0-rc.1` < `0.2.0`), so someone running a
 * prerelease is still offered the final one. This repo has shipped an
 * `-rc.1` tag before (the updater trial). Build metadata (`+...`) is not
 * accepted — no release pipeline here produces it. No ranges, no
 * caret/tilde, and no dependency for what this needs.
 */
interface Parsed {
  core: [number, number, number];
  pre: string[];
}

function parse(raw: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** SemVer §11: numeric identifiers compare as numbers and below alphanumeric
 * ones, alphanumerics compare as ASCII, and a shorter list of equal
 * identifiers comes first. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return diff;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/** `null` when either side doesn't parse — the caller decides what "can't
 * compare" means (usually: don't offer an update). */
export function compareVersions(a: string, b: string): number | null {
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i++) {
    if (va.core[i] !== vb.core[i]) return va.core[i] - vb.core[i];
  }
  return comparePrerelease(va.pre, vb.pre);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const cmp = compareVersions(candidate, current);
  return cmp !== null && cmp > 0;
}
