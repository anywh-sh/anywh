import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { updateDownloadE2EFixtures, updateE2EFixtures } from "../../wdio.conf.js";

// The in-app updater, background-install flow. update.spec.js covers the
// notify-only path (GitHub check, modal, opener); this is the tier that runs
// the real thing end to end, with no modal click anywhere:
//
//   scheduled check -> real `check()` against a fixture `latest.json` -> real
//   `download()` that verifies the artifact's minisign signature against the
//   pubkey in tauri.e2e.conf.json -> real `install()`, which on Linux
//   overwrites the running binary on disk -> the title-bar "Restart to update"
//   button -> real `relaunch()` into what install() wrote.
//
// What makes the last two steps checkable is the artifact: a signed shell
// script (fixtures/updater/update-artifact.bin) standing in for the next
// release. install() writes it over the e2e binary, so (1) the file on disk
// equals the artifact the moment the button appears — which is exactly the
// "quit and reopen lands on the new version" guarantee — and (2) the relaunch
// runs the script, which writes a marker file. The real binary is parked in
// the temp dir first and put back afterwards, or every later spec would find a
// shell script where the app should be.
//
// Two fixture servers because the path has two independent hops:
// `updateE2EFixtures` stands in for the GitHub "latest release" endpoint
// `app_check_latest_release` polls first (the same server update.spec.js uses,
// on the same port, safe to reuse because only one spec file's app process is
// ever alive at a time), and a second one for the manifest/artifact
// `tauri-plugin-updater` itself fetches, at the port hardcoded into
// tauri.e2e.conf.json (see wdio.conf.js for why that one can't be an env var).
const FAKE_TAG = "v99.0.0";
const FAKE_VERSION = "99.0.0"; // comfortably newer than any real release or the e2e build's own 0.1.x
const FAKE_HTML_URL = `https://github.com/anywh-sh/anywh/releases/tag/${FAKE_TAG}`;
// ANYWH_E2E_LOCALE=pt-BR renders the flow in Portuguese (used for the
// screenshots); the labels the spec looks for follow it.
const PT = process.env.ANYWH_E2E_LOCALE === "pt-BR";
const RESTART_LABEL = PT ? "Reiniciar para atualizar" : "Restart to update"; // the button's aria-label
const FOOTER_LABEL = PT ? `Reiniciar na ${FAKE_VERSION}` : `Restart into ${FAKE_VERSION}`;
const ARTIFACT_BYTES = readFileSync(updateDownloadE2EFixtures.artifactPath);
// Not trimmed — the real release pipeline (scripts/build-latest-json.mjs)
// reads its .sig fixtures the same raw way, and this fixture exists to
// match that path exactly rather than a convenient approximation of it.
const ARTIFACT_SIGNATURE = readFileSync(updateDownloadE2EFixtures.signaturePath, "utf8");

function restoreBinary() {
  const { appBinaryPath, backupPath } = updateDownloadE2EFixtures;
  if (!existsSync(backupPath)) return;
  // Copy beside, then rename over: the app may still be running from the path,
  // and writing into a running binary fails with ETXTBSY while a rename
  // replaces the directory entry.
  const staged = `${appBinaryPath}.restore`;
  copyFileSync(backupPath, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, appBinaryPath);
  rmSync(backupPath);
}

describe("anywh in-app updater — background install", () => {
  let githubServer;
  let manifestServer;

  before(async () => {
    // A run that died before its `after` leaves the script where the app
    // belongs; put the real binary back first.
    restoreBinary();
    copyFileSync(updateDownloadE2EFixtures.appBinaryPath, updateDownloadE2EFixtures.backupPath);
    rmSync(updateDownloadE2EFixtures.relaunchMarker, { force: true });

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

    // Both servers are up, so the scheduled check that runs on load finds the
    // update. The update settings are reset rather than seeded with a mode:
    // the e2e build's forced-updatable origin makes "no saved mode" resolve to
    // automatic, and that default is what this spec proves. (The webview
    // persists localStorage on disk across runs, and settings.ts holds the
    // store in memory after import — hence the reload.)
    await browser.execute((locale) => {
      let settings = {};
      try {
        const raw = localStorage.getItem("anywh:settings");
        settings = raw ? JSON.parse(raw) : {};
      } catch {
        settings = {};
      }
      delete settings.app;
      localStorage.setItem("anywh:settings", JSON.stringify(settings));
      // Only for a screenshot run: ANYWH_E2E_LOCALE=pt-BR renders the same flow
      // in the second language.
      if (locale) localStorage.setItem("anywh:locale", locale);
    }, process.env.ANYWH_E2E_LOCALE ?? "");
    await browser.execute(() => window.location.reload());
  });

  after(async () => {
    await Promise.all([
      new Promise((resolveClosed) => githubServer.close(() => resolveClosed())),
      new Promise((resolveClosed) => manifestServer.close(() => resolveClosed())),
    ]);
    restoreBinary();
  });

  it("downloads, verifies and installs in the background, then offers the restart in the title bar — no modal", async () => {
    const restart = await $(`//button[@aria-label="${RESTART_LABEL}"]`);
    await restart.waitForExist({
      timeout: 30000,
      timeoutMsg:
        `the title bar never showed "${RESTART_LABEL}" — either the scheduled check never ran, the real download ` +
        "never started, tauri-plugin-updater rejected the fixture artifact's signature against " +
        "tauri.e2e.conf.json's test pubkey, or install() failed",
    });
    await expect(await $('[role="dialog"]').isExisting()).toBe(false);
    if (process.env.ANYWH_E2E_SCREENSHOTS) {
      await browser.saveScreenshot(
        join(process.env.ANYWH_E2E_SCREENSHOTS, `update-restart-button-${process.env.ANYWH_E2E_LOCALE || "en"}.png`),
      );
    }

    // install() already ran: the binary on disk is the update. This is what a
    // quit-and-reopen would start, without the button ever being pressed.
    expect(readFileSync(updateDownloadE2EFixtures.appBinaryPath).equals(ARTIFACT_BYTES)).toBe(true);
  });

  it("the footer indicator offers the restart too", async () => {
    const indicator = await $(`//button[contains(., "${FOOTER_LABEL}")]`);
    await indicator.waitForExist({ timeout: 5000 });
  });

  it("the title-bar button relaunches into the installed version", async () => {
    const restart = await $(`//button[@aria-label="${RESTART_LABEL}"]`);
    // Deferred, not `restart.click()`: the relaunch kills the app before a
    // WebDriver click can answer, and the failed request would fail the test.
    await browser.execute((button) => {
      setTimeout(() => button.click(), 1000);
    }, restart);
    // The session ends before the app goes away: afterwards there is no driver
    // left to answer the runner's own end-of-session request, which would fail
    // a spec whose tests all passed. Clearing the id is what tells the runner
    // there is nothing left to end.
    await browser.deleteSession();
    browser.sessionId = undefined;

    // The relaunch replaces the process with the installed script, which
    // writes the marker; the old webview is gone by then, so this is a plain
    // file poll rather than a browser command.
    const deadline = Date.now() + 15000;
    while (!existsSync(updateDownloadE2EFixtures.relaunchMarker)) {
      if (Date.now() > deadline) throw new Error("the restart button never relaunched into the installed update");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    expect(readFileSync(updateDownloadE2EFixtures.relaunchMarker, "utf8")).toContain("relaunched into the updated build");
  });
});
