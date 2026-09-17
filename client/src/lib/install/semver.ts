/**
 * Strictly MAJOR.MINOR.PATCH, as produced by this repo's own release
 * pipeline (`scripts/bump-version.mjs`) — no ranges, no caret/tilde, no
 * dependency worth adding for comparing three integers. An optional `v`
 * prefix and an optional `-prerelease` suffix are both accepted and
 * ignored, since GitHub tags carry the former and this repo has shipped an
 * `-rc.1` tag before (see the Fase B ensign-tag step of the updater plan).
 */
function parse(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `null` when either side doesn't parse — the caller decides what "can't
 * compare" means (usually: don't offer an update). */
export function compareVersions(a: string, b: string): number | null {
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const cmp = compareVersions(candidate, current);
  return cmp !== null && cmp > 0;
}
