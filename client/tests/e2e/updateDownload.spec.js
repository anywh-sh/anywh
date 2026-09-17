import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { updateDownloadE2EFixtures, updateE2EFixtures } from "../../wdio.conf.js";

// The in-app updater's Phase B (auto-download). update.spec.js's Phase A
// coverage proves the GitHub check and the modal; every JS-side unit/
// component test for the download path (appUpdate.test.ts,
// UpdateModal.test.tsx, StatusBar.test.tsx) injects a fake `downloadUpdate`
// and never calls the real plugin. This is the one tier that does: a real
// `check()` against a fixture `latest.json`, a real `update.download()`
// that verifies the artifact's minisign signature against the pubkey baked
// into the e2e build (src-tauri/tauri.e2e.conf.json's
// `plugins.updater.pubkey`), and the real StatusBar/UpdateModal reaction
// once that download lands in `getDownloadedUpdate()`. It deliberately
// stops there — never clicking "Restart now" — since `installAndRestart`
// genuinely replaces the running binary and relaunches it, which is neither
// safe nor deterministic inside a test run (see updaterPlugin.ts and
// .anywh/skills/tests/SKILL.md).
//
// Two fixture servers run here because the download path has two
// independent hops: `updateE2EFixtures` stands in for the GitHub "latest
// release" endpoint `app_check_latest_release` polls first — the same
// server update.spec.js uses, on the same port, safe to reuse because only
// one spec file's app process is ever alive at a time — and
// `updateDownloadE2EFixtures` stands in for the update manifest/artifact
// `tauri-plugin-updater` itself then fetches, at the port hardcoded into
// tauri.e2e.conf.json (see wdio.conf.js for why that one can't be threaded
// through an env var the way the GitHub endpoint is).
const FAKE_TAG = "v99.0.0";
const FAKE_VERSION = "99.0.0"; // comfortably newer than any real release or the e2e build's own 0.1.x
const FAKE_HTML_URL = `https://github.com/anywh-sh/anywh/releases/tag/${FAKE_TAG}`;
const ARTIFACT_BYTES = readFileSync(updateDownloadE2EFixtures.artifactPath);
// Not trimmed — the real release pipeline (scripts/build-latest-json.mjs)
// reads its .sig fixtures the same raw way, and this fixture exists to
// match that path exactly rather than a convenient approximation of it.
const ARTIFACT_SIGNATURE = readFileSync(updateDownloadE2EFixtures.signaturePath, "utf8");

describe("anywh in-app updater — auto-download", () => {
  let githubServer;
  let manifestServer;

  before(async () => {
    // Same disk-persisted-localStorage trap update.spec.js documents (see
    // that file), plus a seed this spec needs that neither a fresh profile
    // nor that file's own before() ever sets: `auto-download` only exists
    // once explicitly chosen, and no spec in this tier can drag a radio
    // click blind — the toggle itself is already real-click-tested by
    // update.spec.js, so seeding the mode directly here is deliberate, not
    // a shortcut around coverage that exists elsewhere.
    await browser.execute(() => {
      let settings = {};
      try {
        const raw = localStorage.getItem("anywh:settings");
        settings = raw ? JSON.parse(raw) : {};
      } catch {
        settings = {};
      }
      settings.app = { updateMode: "auto-download" };
      localStorage.setItem("anywh:settings", JSON.stringify(settings));
    });
    await browser.execute(() => window.location.reload());
    await $('[aria-label="New conversation"]').waitForExist({ timeout: 15000 });

    githubServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: FAKE_TAG, html_url: FAKE_HTML_URL }));
    });
    await new Promise((resolveListening, reject) => {
      githubServer.once("error", reject);
      githubServer.listen(updateE2EFixtures.port, "127.0.0.1", () => resolveListening());
    });

    manifestServer = createServer((req, res) => {
      if (req.url === "/latest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: FAKE_VERSION,
            notes: "",
            pub_date: new Date().toISOString(),
            // "linux-x86_64" — tauri-plugin-updater's own target()
            // auto-detection (updater.rs, no `.target()` override at plugin
            // registration in lib.rs), same key
            // scripts/build-latest-json.mjs uses for a real release.
            platforms: {
              "linux-x86_64": {
                signature: ARTIFACT_SIGNATURE,
                url: `http://127.0.0.1:${updateDownloadE2EFixtures.port}/artifact`,
              },
            },
          }),
        );
        return;
      }
      if (req.url === "/artifact") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(ARTIFACT_BYTES);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolveListening, reject) => {
      manifestServer.once("error", reject);
      manifestServer.listen(updateDownloadE2EFixtures.port, "127.0.0.1", () => resolveListening());
    });
  });

  after(async () => {
    await Promise.all([
      new Promise((resolveClosed) => githubServer.close(() => resolveClosed())),
      new Promise((resolveClosed) => manifestServer.close(() => resolveClosed())),
    ]);
  });

  it("Check for updates downloads and signature-verifies the real update before the modal opens", async () => {
    const menu = await $('[aria-label="Menu"]');
    await menu.waitForExist({ timeout: 15000 });
    // Keyboard, not a click — same Radix pointerdown limitation update.spec.js
    // documents for this driver.
    await menu.click();
    await browser.keys("Enter");

    const item = await $('//*[@role="menuitem" and contains(., "Check for updates")]');
    await item.waitForExist({ timeout: 5000 });
    await browser.keys("ArrowDown");
    await browser.keys("Enter");

    // handleCheckForUpdates (App.tsx) awaits the whole scheduled check —
    // including runCheck's best-effort download attempt — before opening
    // the modal, so by the time the dialog exists the real download has
    // already finished (or failed silently, which is exactly what the
    // assertion below catches: a rejected signature never produces "Update
    // ready", only the plain "Update available" state update.spec.js
    // already covers).
    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 10000 });

    const restartButton = await dialog.$('.//button[contains(., "Restart now")]');
    await restartButton.waitForExist({
      timeout: 10000,
      timeoutMsg:
        'the modal never reached the "Restart now" state — either the real download never started, or ' +
        "tauri-plugin-updater rejected the fixture artifact's signature against tauri.e2e.conf.json's test pubkey",
    });

    const title = await dialog.$('.//*[contains(text(), "Update ready")]');
    await expect(title).toBeExisting();
  });

  it("the footer indicator swaps to the restart prompt once the download is ready", async () => {
    const indicator = await $(`//button[contains(., "Restart into ${FAKE_VERSION}")]`);
    await indicator.waitForExist({ timeout: 5000 });
  });
});
