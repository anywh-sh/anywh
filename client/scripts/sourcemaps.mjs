// After `vite build`, in the release build only (ANYWH_SOURCEMAPS=1, which
// also makes Vite write "hidden" source maps): hands the maps to PostHog's
// error tracking, so an exception the app reports from the minified bundle
// reads as the file and line it came from, then deletes every map from
// `dist/` before Tauri bundles it. A map never ships inside the app.
//
// The upload needs POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID (a personal
// API key with error tracking write access, read by posthog-cli itself).
// Without them, or when the upload fails, the release still builds: it only
// loses readable stack traces. What cannot be skipped is the deletion, and
// the build fails if a map is left.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POSTHOG_CLI = "@posthog/cli@0.20.1";
const RELEASE_NAME = "anywh-client";

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(clientDir, "dist");

/** Every file under `dir` whose name ends in `.map`. */
function mapsUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...mapsUnder(path));
    else if (entry.endsWith(".map")) found.push(path);
  }
  return found;
}

function posthogCli(args) {
  const result = spawnSync("npx", ["--yes", POSTHOG_CLI, ...args], { cwd: clientDir, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

function main() {
  if (process.env.ANYWH_SOURCEMAPS !== "1") return;
  const version = JSON.parse(readFileSync(join(clientDir, "package.json"), "utf8")).version;
  if (process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID) {
    const release = ["--release-name", RELEASE_NAME, "--release-version", version];
    const uploaded = posthogCli(["sourcemap", "inject", "--directory", "dist", ...release]) && posthogCli(["sourcemap", "upload", "--directory", "dist", ...release, "--delete-after"]);
    if (!uploaded) console.warn("[sourcemaps] the upload to PostHog failed; this release's stack traces stay minified");
  } else {
    console.warn("[sourcemaps] POSTHOG_CLI_API_KEY or POSTHOG_CLI_PROJECT_ID is not set; source maps are not uploaded");
  }
  for (const map of mapsUnder(dist)) rmSync(map);
  const left = mapsUnder(dist);
  if (left.length > 0) {
    console.error(`[sourcemaps] source maps left in dist/: ${left.join(", ")}`);
    process.exit(1);
  }
}

main();
