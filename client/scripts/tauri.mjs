// `npm run tauri` entry point. Forwards to the Tauri CLI, first folding
// ANYWH_APP_IDENTIFIER into the config when it is set.
//
// The checked-in identifier in tauri.conf.json is a neutral development one
// on purpose: the identifier of the official build belongs to whoever
// signs and publishes it, so the build environment supplies it (the release
// workflow, or the private iOS build). It is also what names the app's data
// directory on desktop (and, on macOS, the bundle id WebKit keys its storage
// by), so an official build without it would start with an empty profile
// list — release.yml refuses to run without it.
//
// The identifier reaches the CLI as `--config` (what the bundler, and so the
// macOS Info.plist, reads) and as TAURI_CONFIG (what the Rust build reads);
// see scripts/tauriArgs.mjs for why both. A TAURI_CONFIG already in the
// environment is kept and the identifier is merged over it.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { applyIdentifier } from "./tauriArgs.mjs";

const shaped = applyIdentifier(process.argv.slice(2), process.env);
if ("error" in shaped) {
  console.error(shaped.error);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(process.execPath, [cli, ...shaped.args], { stdio: "inherit", env: shaped.env });
process.exit(result.status ?? 1);
