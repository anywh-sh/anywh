import { resolve } from "node:path";

// Real end-to-end tier (.anywh/skills/tests/SKILL.md) — drives the actual
// Tauri app (real window, real webview) via @wdio/tauri-service's embedded
// provider, which needs no external driver on any platform (unlike the
// older tauri-driver, Linux/Windows only). The binary must already be built
// with the `e2e` Cargo feature (client/src-tauri/Cargo.toml) and the
// tauri.e2e.conf.json capabilities override:
//
//   npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
//
// Neither the feature nor the extra capability is present in a normal
// `tauri dev`/`tauri build` — this is an opt-in, e2e-only binary.
const appBinaryPath = resolve(import.meta.dirname, "src-tauri/target/debug/anywh");

export const config = {
  runner: "local",
  specs: ["./tests/e2e/*.spec.js"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application: appBinaryPath },
      "wdio:tauriServiceOptions": {
        appBinaryPath,
        driverProvider: "embedded",
      },
    },
  ],
  logLevel: "info",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  // The app under test boots against whatever its real app-data dir holds.
  // On a fresh runner that is nothing — and with no profile the app shows
  // its first-run screen, not the shell every spec here drives (no spec can
  // type its way through that screen: this driver can't fill an input, see
  // .anywh/skills/tests/SKILL.md). So seed one profile and reload once. The
  // id is deliberately not the retired `default` seed's, so the one-shot
  // ghost migration in profiles.ts never mistakes it for the ghost. A dir
  // that already holds profiles is left exactly as it is.
  before: async () => {
    const seeded = await browser.execute(() => {
      const raw = localStorage.getItem("anywh:profiles");
      try {
        if (raw && JSON.parse(raw).length > 0) return false;
      } catch {
        // Unreadable — the app reads that as empty too; reseed.
      }
      localStorage.setItem(
        "anywh:profiles",
        JSON.stringify([{ id: "e2e", label: "Default", host: "127.0.0.1", relayPort: 8765 }]),
      );
      return true;
    });
    if (seeded) {
      await browser.execute(() => window.location.reload());
      await $('[aria-label="New conversation"]').waitForExist({ timeout: 15000 });
    }
  },
};
