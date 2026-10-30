import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e2eSeedPort, firstRunE2EFixtures } from "../../wdio.conf.js";

// The onboarding in the real Tauri window, by click only (this driver can't
// type — typing and Radix pickers are the UI tier's, client/tests/ui). The
// app runs with a throwaway HOME and `fake-install.sh` as its installer
// (wdio.conf.js), so "set up on this machine" goes through the real
// relay_setup.rs: the real probe of an empty disk, the real prerequisites
// (with a fake `systemctl`), the real process spawn and porcelain stream, and
// a real relay — this checkout's relay/dist with the fake `claude` — that the
// app then verifies and asks for its agents.
//
// With ANYWH_E2E_SCREENSHOTS set to a directory, every screen is captured in
// English and Portuguese, named after the design's mock.

const { installDir } = firstRunE2EFixtures;
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

const COPY = {
  en: {
    welcome: "Your coding agents, wherever you are.",
    setUp: "Set up on this machine",
    otherMachine: "The agent runs on another machine?",
    otherTitle: "Connect to another machine",
    advanced: "Advanced options",
    terminalTab: "In the terminal",
    alreadyRan: "Already ran it, connect",
    back: "Back",
    preparing: "Preparing this machine",
    stopped: "The install stopped.",
    continueInTerminal: "Continue in the terminal",
    agents: "Your agents",
    startWith: "Start with Claude Code",
  },
  pt: {
    welcome: "Seus agentes de código, onde você estiver.",
  },
};

const LOCALE_NAMES = { en: "English", "pt-BR": "Português (Brasil)" };
let locale = "en";

const byText = (text) => $(`//*[normalize-space(text())="${text}"]`);
const button = (text) => $(`//button[normalize-space()="${text}"]`);

async function click(text) {
  const target = await button(text);
  await target.waitForClickable({ timeout: 15000 });
  await target.click();
}

/** The footer's language picker. Radix opens its menu on pointerdown, which
 * this driver's click doesn't send, so the pointerdown is dispatched by hand;
 * picking the item is a plain click. */
async function setLocale(next) {
  await browser.execute((current) => {
    const trigger = [...document.querySelectorAll("footer button")].find((b) => b.textContent?.trim() === current);
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  }, locale);
  const item = await $(`//*[@role="menuitemradio"][normalize-space()="${LOCALE_NAMES[next]}"]`);
  await item.waitForExist({ timeout: 5000 });
  await browser.execute((el) => el.click(), item);
  await $(`//footer//button[normalize-space()="${next}"]`).waitForExist({ timeout: 5000 });
  locale = next;
}

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // After the screen's own transitions, never mid-fade.
  await browser.pause(400);
  await browser.saveScreenshot(join(SHOTS, `${name}-${locale === "en" ? "en" : "pt-br"}.png`));
}

/** The current screen in both languages, ending back in English. */
async function shotBoth(name) {
  if (!SHOTS) return;
  await shot(name);
  await setLocale("pt-BR");
  await shot(name);
  await setLocale("en");
}

function stopFakeRelay() {
  const pidFile = join(installDir, "relay.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  // That exact process, never a pattern: a pattern for `node dist/server.js`
  // also matches the relays a developer's machine really runs.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  rmSync(pidFile, { force: true });
}

describe("anywh onboarding", () => {
  const seeded = JSON.stringify([{ id: "e2e", label: "Default", host: "127.0.0.1", relayPort: e2eSeedPort }]);

  before(async () => {
    await browser.execute(() => {
      localStorage.setItem("anywh:profiles", "[]");
      localStorage.removeItem("anywh:first-run:pending-agents");
      localStorage.setItem("anywh:locale", "en");
      window.location.reload();
    });
    await byText(COPY.en.welcome).waitForExist({ timeout: 15000 });
  });

  it("opens on the welcome, in its own window, with no shell behind it", async () => {
    await expect(await $('//*[contains(text(), "anywh.sh — onboarding")]')).toBeExisting();
    await expect(await $('[aria-label="New session"]')).not.toBeExisting();
    await shotBoth("01-welcome");

    // The language picker is reachable from the first screen.
    await setLocale("pt-BR");
    await byText(COPY.pt.welcome).waitForExist({ timeout: 5000 });
    await setLocale("en");
  });

  it("reaches another machine and the advanced options, and comes back", async () => {
    await click(COPY.en.otherMachine);
    await byText(COPY.en.otherTitle).waitForExist({ timeout: 10000 });
    await shotBoth("12-other-code");

    await click(COPY.en.advanced);
    await $(`//h1[normalize-space()="${COPY.en.advanced}"]`).waitForExist({ timeout: 10000 });
    await shotBoth("14-advanced-app");

    await click(COPY.en.terminalTab);
    await button(COPY.en.alreadyRan).waitForExist({ timeout: 5000 });
    await shotBoth("15-advanced-terminal");

    await click(COPY.en.back);
    await byText(COPY.en.otherTitle).waitForExist({ timeout: 5000 });
    await click(COPY.en.back);
    await byText(COPY.en.welcome).waitForExist({ timeout: 5000 });
  });

  it("an install that stops says so, and continuing in the terminal opens the terminal instructions", async () => {
    writeFileSync(join(installDir, "pause"), "3\n");
    writeFileSync(join(installDir, "fail"), "download download_failed curl: (6) Could not resolve host: github.com\n");

    await click(COPY.en.setUp);
    await byText(COPY.en.preparing).waitForExist({ timeout: 15000 });
    await byText(COPY.en.stopped).waitForExist({ timeout: 30000 });
    await expect(await byText("curl: (6) Could not resolve host: github.com")).toBeExisting();
    await shotBoth("05-install-stopped");

    await click(COPY.en.continueInTerminal);
    await button(COPY.en.alreadyRan).waitForExist({ timeout: 10000 });
    await click(COPY.en.back);
    await byText(COPY.en.welcome).waitForExist({ timeout: 5000 });
  });

  it("sets this machine up in two clicks, finds its agents and starts with the one picked", async () => {
    writeFileSync(join(installDir, "pause"), "4\n");

    await click(COPY.en.setUp);
    await byText(COPY.en.preparing).waitForExist({ timeout: 15000 });
    await shotBoth("02-preparing");

    const start = await button(COPY.en.startWith);
    await start.waitForExist({ timeout: 60000 });
    await shotBoth("07-agents");

    // The minimum window size holds while the onboarding is on screen.
    // [S3] If WebKitGTK under Xvfb ignored size hints this would fail; it is
    // asserted only because it was seen to hold.
    await browser.setWindowSize(400, 400);
    await browser.pause(500);
    const held = await browser.getWindowSize();
    expect(held.width).toBeGreaterThanOrEqual(480);
    expect(held.height).toBeGreaterThanOrEqual(520);
    // Back to a size where the shell shows its sidebar.
    await browser.setWindowSize(1000, 700);
    await browser.pause(300);

    await start.click();
    await $('[aria-label="New session"]').waitForExist({ timeout: 20000 });
    await expect(await byText(COPY.en.welcome)).not.toBeExisting();

    // And lifts once it is gone.
    await browser.setWindowSize(400, 400);
    await browser.pause(500);
    const released = await browser.getWindowSize();
    expect(released.width).toBeLessThan(480);
    await browser.setWindowSize(1000, 700);
  });

  // Puts the shell back for whatever runs next against this app-data dir,
  // and stops the relay the fake installer started.
  after(async () => {
    stopFakeRelay();
    await browser.execute((profiles) => {
      localStorage.setItem("anywh:profiles", profiles);
      localStorage.removeItem("anywh:first-run:pending-agents");
      window.location.reload();
    }, seeded);
    await $('[aria-label="New session"]').waitForExist({ timeout: 15000 });
  });
});
