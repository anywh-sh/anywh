import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// update.spec.js's fixtures. The port has to be static: each spec file gets
// its own freshly spawned app process, using the env below, before that
// file's own `before()` hook (where update.spec.js's fixture HTTP server
// actually starts listening) ever runs — so `ANYWH_UPDATE_ENDPOINT` has to
// be a value known here, not discovered later from an ephemeral listener.
// `openedUrlsLog` is where the fake `xdg-open` (tests/e2e/fixtures/bin)
// records what it was asked to open, standing in for a real browser launch
// — see that file and update.spec.js for why.
export const updateE2EFixtures = {
  port: 47862,
  endpoint: "http://127.0.0.1:47862/repos/anywh-sh/anywh/releases/latest",
  openedUrlsLog: resolve(tmpdir(), "anywh-e2e-opened-urls.log"),
};
const fakeOpenerBinDir = resolve(import.meta.dirname, "tests/e2e/fixtures/bin");

// updateDownload.spec.js's fixtures — the real tauri-plugin-updater
// download+signature-verify path, not just the GitHub check above. Unlike
// `updateE2EFixtures.endpoint`, this port can't be threaded in through an
// env var: the plugin's endpoints/pubkey are read once at plugin
// registration time from tauri.conf.json (`Builder::new().build()` has no
// per-call override, unlike updater.rs's own `ANYWH_UPDATE_ENDPOINT`
// command), so `47864` is also hardcoded into
// `src-tauri/tauri.e2e.conf.json`'s `plugins.updater.endpoints` — change one
// without the other and the spec times out waiting for a download that
// never starts. `pubkey` there is the public half of a disposable test-only
// keypair generated just for this fixture; `artifactPath`/`signaturePath`
// were signed with its (discarded) private half.
export const updateDownloadE2EFixtures = {
  port: 47864,
  artifactPath: resolve(import.meta.dirname, "tests/e2e/fixtures/updater/update-artifact.bin"),
  signaturePath: resolve(import.meta.dirname, "tests/e2e/fixtures/updater/update-artifact.bin.sig"),
};

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
        // Prefixing PATH (never replacing it) so the fake xdg-open wins
        // the real `open` crate's lookup without breaking anything else
        // the app's process might need to find on PATH.
        env: {
          ANYWH_UPDATE_ENDPOINT: updateE2EFixtures.endpoint,
          ANYWH_E2E_OPENED_URLS_LOG: updateE2EFixtures.openedUrlsLog,
          // Forces app_install_source() to report `updatable: true`
          // (updater.rs's E2E_FORCE_UPDATABLE_ENV) — a plain --no-bundle
          // debug build is honestly "unknown"/not updatable otherwise,
          // which would make updateDownload.spec.js's auto-download mode
          // get silently coerced back to `notify` before it ever reaches
          // the plugin. Harmless for every other spec: it only widens which
          // update modes UpdateModal offers, never which one is selected.
          ANYWH_E2E_FORCE_UPDATABLE: "1",
          PATH: `${fakeOpenerBinDir}:${process.env.PATH}`,
        },
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
    rmSync(updateE2EFixtures.openedUrlsLog, { force: true });

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
