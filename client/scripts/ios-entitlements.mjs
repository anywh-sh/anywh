// `tauri ios init` writes an empty entitlements file and `gen/` is gitignored,
// so the push entitlement has to be re-applied after every init. Idempotent.
// `development` is correct for every build type: Xcode swaps it for
// `production` when it signs for App Store / TestFlight distribution.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "gen", "apple");
const file = join(root, "client_iOS", "client_iOS.entitlements");

if (!existsSync(file)) {
  console.error(`${file} not found — run \`tauri ios init\` first`);
  process.exit(1);
}

const plist = readFileSync(file, "utf8");
if (plist.includes("<key>aps-environment</key>")) {
  console.log("aps-environment already set");
} else {
  const entry = "<key>aps-environment</key>\n\t<string>development</string>";
  const next = plist.includes("<dict/>") ? plist.replace("<dict/>", `<dict>\n\t${entry}\n</dict>`) : plist.replace("</dict>", `\t${entry}\n</dict>`);
  writeFileSync(file, next);
  console.log("added aps-environment=development");
}
