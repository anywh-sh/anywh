// `npm run tauri` entry point. Forwards to the Tauri CLI, first folding
// ANYWH_APP_IDENTIFIER into the config when it is set.
//
// The checked-in identifier in tauri.conf.json is a neutral development one
// on purpose: the identifier of the official build belongs to whoever
// signs and publishes it, so the build environment supplies it (the release
// workflow, or the private iOS build). It is also what names the app's data
// directory on desktop, so an official build without it would start with an
// empty profile list — release.yml refuses to run without it.
//
// TAURI_CONFIG is the CLI's own merge-patch channel, and it is also what
// `tauri ios init` and the Rust build read, so one variable covers `dev`,
// `build` and `ios init` alike. A TAURI_CONFIG already in the environment is
// kept and the identifier is merged over it.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const identifier = process.env.ANYWH_APP_IDENTIFIER?.trim();
if (identifier) {
  // Becomes a bundle id and a file name on some platforms; refuse anything
  // that isn't a plain reverse-DNS string rather than pass it on.
  if (!/^[A-Za-z0-9]+([.-][A-Za-z0-9]+)+$/.test(identifier)) {
    console.error(`ANYWH_APP_IDENTIFIER is not a valid identifier: ${JSON.stringify(identifier)}`);
    process.exit(1);
  }
  let existing = {};
  if (process.env.TAURI_CONFIG) {
    try {
      existing = JSON.parse(process.env.TAURI_CONFIG);
    } catch {
      console.error("TAURI_CONFIG is set but is not valid JSON");
      process.exit(1);
    }
  }
  process.env.TAURI_CONFIG = JSON.stringify({ ...existing, identifier });
}

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
