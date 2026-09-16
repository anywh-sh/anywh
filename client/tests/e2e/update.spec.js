import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { updateE2EFixtures } from "../../wdio.conf.js";

// The in-app updater's Fase A (notify-only — Trello r63WoWD7): a GitHub
// release check plus a banner, never an auto-restart. Every other tier
// covers this feature in isolation — appUpdate.test.ts drives the
// check/dismiss/scheduling policy with fake deps, UpdateBanner.test.tsx and
// UpdatesSettings.test.tsx render the components standalone. None of them
// proves the whole wire fires inside the real Tauri IPC and webview: a
// genuine "Check now" click reaching the Rust command
// (`app_check_latest_release`), the banner that command's answer produces,
// and — the one thing no other tier can catch a typo in — that the
// `opener:allow-open-url` capability actually permits `https://github.com/*`
// (src-tauri/capabilities/default.json). A typo there is invisible
// everywhere else and only shows up as a silently rejected `openUrl`.
//
// No network: the Rust command reads `ANYWH_UPDATE_ENDPOINT` instead of the
// real GitHub API when set (updater.rs's own escape hatch, built for this
// tier) — wdio.conf.js points it at a fixed local port and this file is the
// fixture server answering on it. And no real browser: wdio.conf.js also
// prefixes PATH with a fake `xdg-open` (tests/e2e/fixtures/bin) that just
// records the URL it was asked to open — see that file for why a real
// browser popping up mid-CI-run isn't a risk worth taking here.
const FAKE_TAG = "v99.0.0";
const FAKE_VERSION = "99.0.0"; // comfortably newer than any real release
const FAKE_HTML_URL = `https://github.com/anywh-sh/anywh/releases/tag/${FAKE_TAG}`;

describe("anywh in-app updater", () => {
  let server;

  before(async () => {
    // The embedded WebKitGTK webview persists localStorage on real disk
    // across separate wdio invocations (unlike a fresh browser profile per
    // run) — a prior run of this very spec leaves `dismissedVersion:
    // "99.0.0"` behind, which then silently suppresses the banner on the
    // next run and makes every assertion below flaky depending on what ran
    // last. Clearing the updater's own settings slice up front is what
    // makes this spec repeatable regardless of history — and it has to be
    // followed by a reload: settings.ts loads the whole store into a
    // module-level variable exactly once at import time and every read
    // after that (`readSettings()`) returns that in-memory copy rather than
    // re-parsing localStorage, so editing localStorage alone leaves the
    // already-running app holding the stale value and re-persisting it on
    // its own next write (e.g. this spec's own mode-control clicks).
    await browser.execute(() => {
      const raw = localStorage.getItem("anywh:settings");
      if (!raw) return;
      try {
        const settings = JSON.parse(raw);
        delete settings.app;
        localStorage.setItem("anywh:settings", JSON.stringify(settings));
      } catch {
        // Malformed — readSettings() already treats that as "use the default".
      }
    });
    await browser.execute(() => window.location.reload());
    await $('[aria-label="New conversation"]').waitForExist({ timeout: 15000 });

    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: FAKE_TAG, html_url: FAKE_HTML_URL }));
    });
    await new Promise((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(updateE2EFixtures.port, "127.0.0.1", () => resolveListening());
    });
  });

  after(async () => {
    await new Promise((resolveClosed) => server.close(() => resolveClosed()));
  });

  async function openUpdatesPage() {
    const menu = await $('[aria-label="Menu"]');
    await menu.waitForExist({ timeout: 15000 });
    // Keyboard, not a click: a WebDriver click never delivers the
    // `pointerdown` a Radix trigger opens on (see shell.spec.js).
    await menu.click();
    await browser.keys("Enter");

    const settingsItem = await $('[role="menuitem"]');
    await settingsItem.waitForExist({ timeout: 5000 });
    await browser.keys("Enter");

    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 5000 });

    // Plain `<button>` in the nav rail, not a portal-based trigger, so a
    // driver click reaches it fine (see settings.spec.js's Appearance case).
    const nav = await $('//nav//button[contains(., "Updates")]');
    await nav.waitForExist({ timeout: 5000 });
    await nav.click();

    const heading = await $('//h2[contains(text(), "Updates")]');
    await heading.waitForExist({ timeout: 5000 });
    return dialog;
  }

  async function lastCheckedAt() {
    return browser.execute(() => {
      try {
        return JSON.parse(localStorage.getItem("anywh:settings")).app?.lastCheckedAt ?? null;
      } catch {
        return null;
      }
    });
  }

  async function clickCheckNow() {
    const before = await lastCheckedAt();
    const checkNow = await $('//button[contains(., "Check now")]');
    await checkNow.waitForExist({ timeout: 5000 });
    await checkNow.click();
    // The store write in appUpdate.ts's runCheck() is the concrete signal a
    // check actually completed — waiting for it beats an arbitrary sleep
    // (.anywh/skills/tests/SKILL.md's determinism rule) and is the only way
    // to synchronize on "nothing happened" in the dismissal case below.
    await browser.waitUntil(async () => (await lastCheckedAt()) !== before, {
      timeout: 10000,
      timeoutMsg: "Check now never updated lastCheckedAt — the request to the fixture endpoint didn't complete",
    });
  }

  it("renders the three-state mode control, operable via real clicks", async () => {
    await openUpdatesPage();

    const radiogroup = await $('[role="radiogroup"]');
    await expect(radiogroup).toBeExisting();

    const off = await $('//button[@role="radio" and text()="Off"]');
    await off.waitForExist({ timeout: 5000 });
    await off.click();
    await expect(await off.getAttribute("aria-checked")).toBe("true");

    const notify = await $('//button[@role="radio" and text()="Notify"]');
    await notify.click();
    await expect(await notify.getAttribute("aria-checked")).toBe("true");
    await expect(await off.getAttribute("aria-checked")).toBe("false");
  });

  it("Check now reaches the real Rust command and surfaces a banner", async () => {
    await clickCheckNow();

    const banner = await $(`//*[contains(text(), "${FAKE_VERSION}")]`);
    await banner.waitForExist({ timeout: 5000 });
  });

  it("the banner's action opens the release through the real opener capability", async () => {
    const viewRelease = await $('//button[contains(., "View the release")]');
    await viewRelease.waitForExist({ timeout: 5000 });
    await viewRelease.click();

    await browser.waitUntil(
      () =>
        existsSync(updateE2EFixtures.openedUrlsLog) &&
        readFileSync(updateE2EFixtures.openedUrlsLog, "utf8").includes(FAKE_HTML_URL),
      {
        timeout: 5000,
        timeoutMsg:
          'clicking "View the release" never reached the opener plugin with the release URL — either the ' +
          "click didn't fire, or opener:allow-open-url no longer permits https://github.com/*",
      },
    );
  });

  it("dismissing the banner suppresses it for that version, even across another check", async () => {
    const dismiss = await $('[aria-label="Dismiss update notice"]');
    await dismiss.waitForExist({ timeout: 5000 });
    await dismiss.click();

    const banner = () => $(`//*[contains(text(), "${FAKE_VERSION}")]`);
    await browser.waitUntil(async () => !(await banner().isExisting()), {
      timeout: 5000,
      timeoutMsg: "the banner stayed after being dismissed",
    });

    await clickCheckNow();

    // Same tag as before, already dismissed — appUpdate.ts's runCheck()
    // compares the new version against `dismissedVersion` and must not
    // re-open the banner it was just told to stop showing.
    await expect(await banner().isExisting()).toBe(false);
  });
});
