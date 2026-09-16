import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { updateE2EFixtures } from "../../wdio.conf.js";

// The in-app updater's Fase A (notify-only — Trello r63WoWD7): a GitHub
// release check plus a modal, never an auto-restart. Every other tier
// covers this feature in isolation — appUpdate.test.ts drives the
// check/scheduling policy with fake deps, UpdateModal.test.tsx renders the
// component standalone. None of them proves the whole wire fires inside the
// real Tauri IPC and webview: a genuine "Check for updates" click reaching
// the Rust command (`app_check_latest_release`), the modal that command's
// answer produces, and — the one thing no other tier can catch a typo in —
// that the `opener:allow-open-url` capability actually permits
// `https://github.com/*` (src-tauri/capabilities/default.json). A typo
// there is invisible everywhere else and only shows up as a silently
// rejected `openUrl`.
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
    // run) — a prior run of this very spec can leave `updateMode: "off"`
    // behind, which then silently suppresses the check on the next run and
    // makes every assertion below flaky depending on what ran last.
    // Clearing the updater's own settings slice up front is what makes this
    // spec repeatable regardless of history — and it has to be followed by
    // a reload: settings.ts loads the whole store into a module-level
    // variable exactly once at import time and every read after that
    // (`readSettings()`) returns that in-memory copy rather than re-parsing
    // localStorage, so editing localStorage alone leaves the already-running
    // app holding the stale value and re-persisting it on its own next write.
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

  async function openMenu() {
    const menu = await $('[aria-label="Menu"]');
    await menu.waitForExist({ timeout: 15000 });
    // Keyboard, not a click: a WebDriver click never delivers the
    // `pointerdown` a Radix trigger opens on (see shell.spec.js).
    await menu.click();
    await browser.keys("Enter");
  }

  async function clickCheckForUpdates() {
    await openMenu();

    const item = await $('//*[@role="menuitem" and contains(., "Check for updates")]');
    await item.waitForExist({ timeout: 5000 });
    // Keyboard again, same reasoning as opening the trigger: this driver
    // delivers no `pointerdown`, and Radix menu items select on pointer-up —
    // a `click()` looks like it lands (the item highlights) but never fires
    // `onSelect`. "Check for updates" is the second item, after "Settings",
    // so one step down from the first item the menu opens focused on.
    await browser.keys("ArrowDown");
    await browser.keys("Enter");

    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 10000 });
    return dialog;
  }

  it("Check for updates reaches the real Rust command and opens the modal with the release", async () => {
    const dialog = await clickCheckForUpdates();

    // Tag-agnostic, relative XPath, not `*=text` — that bare partial-text
    // selector silently resolves to nothing under this driver (it's
    // WebdriverIO's "partial link text" strategy, which only matches an
    // `<a>`), and the version here renders in a plain `<p>`.
    const version = await dialog.$(`.//*[contains(text(), "${FAKE_VERSION}")]`);
    await version.waitForExist({ timeout: 5000 });
  });

  it("the modal's action opens the release through the real opener capability", async () => {
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

  it("closing the modal leaves the footer indicator, which reopens it", async () => {
    const dialog = () => $('[role="dialog"]');
    // Scoped to the dialog, not a bare `$('[aria-label="Close"]')` — the
    // window's own close button (WindowControls.tsx) carries the identical
    // aria-label, "Close", and sits earlier in the DOM than the dialog's
    // portal content. An unscoped query matches that one first and quits
    // the whole app instead of the modal — confirmed the hard way (this
    // exact mistake killed the embedded WebDriver mid-run).
    const closeButton = await dialog().$('[aria-label="Close"]');
    await closeButton.waitForExist({ timeout: 5000 });
    await closeButton.click();

    await browser.waitUntil(async () => !(await dialog().isExisting()), {
      timeout: 5000,
      timeoutMsg: "the modal stayed open after its close button was clicked",
    });

    // Only a `button` matches here — the dialog's own body also names the
    // version, but as plain text, and it is gone with the dialog closed.
    const indicator = await $(`//button[contains(., "${FAKE_VERSION}")]`);
    await indicator.waitForExist({ timeout: 5000 });
    await indicator.click();

    await dialog().waitForExist({ timeout: 5000 });
    const version = await dialog().$(`.//*[contains(text(), "${FAKE_VERSION}")]`);
    await expect(version).toBeExisting();
  });

  it("the automatic-check toggle inside the modal is operable via real clicks", async () => {
    const radiogroup = await $('[role="radiogroup"]');
    await expect(radiogroup).toBeExisting();

    const off = await $('//button[@role="radio" and text()="Off"]');
    await off.waitForExist({ timeout: 5000 });
    await off.click();
    await expect(await off.getAttribute("aria-checked")).toBe("true");

    const on = await $('//button[@role="radio" and text()="On"]');
    await on.click();
    await expect(await on.getAttribute("aria-checked")).toBe("true");
    await expect(await off.getAttribute("aria-checked")).toBe("false");
  });
});
