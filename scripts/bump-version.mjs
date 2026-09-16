// Bumps the app version everywhere it exists as a literal, and refreshes the
// two lockfiles that `npm ci` would otherwise reject for disagreeing with
// their package.json.
//
// `client/src-tauri/Cargo.toml` is deliberately left untouched: Tauri reads
// the version it stamps on the bundle from `tauri.conf.json`, not Cargo.toml,
// so Cargo.toml stays frozen at "0.1.0" forever (appVersion.test.ts guards
// this — bumping it here would be the kind of "fix" that quietly breaks it).
//
// Usage: node scripts/bump-version.mjs <MAJOR.MINOR.PATCH>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const nextVersion = process.argv[2];
if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  console.error(`Usage: node scripts/bump-version.mjs <MAJOR.MINOR.PATCH>\nGot: ${nextVersion ?? "(nothing)"}`);
  process.exit(1);
}

function bumpJsonVersion(relativePath) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${nextVersion}$2`);
  if (before === after) {
    console.error(`${relativePath}: no "version" field matched, refusing to write`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`bumped ${relativePath}`);
}

function bumpAppVersionTs() {
  const relativePath = "client/src/lib/appVersion.ts";
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/(export const APP_VERSION = ")[^"]+(";)/, `$1${nextVersion}$2`);
  if (before === after) {
    console.error(`${relativePath}: APP_VERSION literal not found, refusing to write`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`bumped ${relativePath}`);
}

bumpJsonVersion("client/package.json");
bumpJsonVersion("client/src-tauri/tauri.conf.json");
bumpJsonVersion("relay/package.json");
bumpAppVersionTs();

// `--package-lock-only` rewrites just the top-level "version" field npm
// insists must match package.json, without touching node_modules or
// re-resolving the dependency tree.
for (const workspace of ["client", "relay"]) {
  execFileSync("npm", ["install", "--package-lock-only"], {
    cwd: join(root, workspace),
    stdio: "inherit",
  });
  console.log(`refreshed ${workspace}/package-lock.json`);
}

console.log(`\nDone. client/src-tauri/Cargo.toml intentionally left at its frozen 0.1.0.`);
