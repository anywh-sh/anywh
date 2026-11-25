// Records a profile in `profiles.json`, for `add-profile.sh`. A source
// checkout or the Linux tarball runs this upsert as `node -e` from the
// script; a Mac with only the app has no `node`, so the SEA binary runs it
// as `anywh-relay record-profile <profiles.json> <id> <label>`. Both must
// write the same thing: keep this in sync with the `node -e` in
// infra/systemd/add-profile.sh.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface ProfileEntry {
  id: string;
  label: string;
  colorIndex?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface Registry {
  version?: number;
  profiles?: unknown;
  [key: string]: unknown;
}

/** Adds or updates `id`'s entry. A new profile gets the smallest
 * `colorIndex` nobody has; an existing one keeps its `colorIndex`,
 * `createdAt` and every field this does not write (the app's own, like the
 * agent preference), and its label when none is given (`""`: a re-run with
 * no `--label`, such as the app moving a Homebrew profile to its own
 * relay). A missing or corrupt file starts an empty registry, so a bad
 * `profiles.json` never blocks provisioning. */
export function recordProfile(path: string, id: string, label: string, now: Date = new Date()): void {
  let data: Registry = { version: 1, profiles: [] };
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as Registry;
    } catch {
      // Corrupt: start over rather than refuse.
    }
  }
  const profiles = Array.isArray(data.profiles) ? (data.profiles as ProfileEntry[]) : [];

  const used = new Set(profiles.map((p) => p.colorIndex).filter((i) => typeof i === "number"));
  let colorIndex = 0;
  while (used.has(colorIndex)) colorIndex++;

  const stamp = now.toISOString();
  const existing = profiles.find((p) => p.id === id);
  const entry = {
    ...existing,
    id,
    label: label || existing?.label || id,
    colorIndex: existing ? existing.colorIndex : colorIndex,
    createdAt: existing ? existing.createdAt : stamp,
    updatedAt: stamp,
  };
  data.profiles = [...profiles.filter((p) => p.id !== id), entry];
  writeFileSync(path, JSON.stringify(data, null, 2));
}
