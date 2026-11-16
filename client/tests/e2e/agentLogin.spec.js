import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startPlanUsageMachine } from "./fixtures/planUsageRelay.mjs";

// Signing an agent in from the app, in the real Tauri window, against a real
// relay with the fake `claude` logged out: the profile's accounts say so, the
// sign-in dialog opens on Connect, shows the provider's page to open and a
// field for the code, and the relay's own `claude auth login` (the fake
// accepts `good-code`) signs it in. Nothing in the app is stubbed.
//
// This driver can't type (see firstRun.spec.js): the code goes into the
// field the way React reads a typed value — the native setter, then an
// `input` event — which still exercises the real form and socket.
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

const byText = (text) => $(`//*[contains(normalize-space(.), "${text}") and not(*[contains(normalize-space(.), "${text}")])]`);

async function openSettings() {
  const menu = await $('[aria-label="Menu"]');
  await menu.waitForExist({ timeout: 15000 });
  // Keyboard, not a click: a WebDriver click never delivers the
  // `pointerdown` a Radix trigger opens on (settings.spec.js).
  await menu.click();
  await browser.keys("Enter");
  await $('[role="menuitem"]').waitForExist({ timeout: 5000 });
  await browser.keys("Enter");
  await $('[role="dialog"]').waitForExist({ timeout: 5000 });
}

describe("agent sign-in", () => {
  let machine;
  let previous;

  before(async () => {
    machine = await startPlanUsageMachine([{ id: "e2e-login", label: "Login", fiveHour: 0.2, sevenDay: 0.1, claudeSignedOut: true }]);
    const { port } = machine.relays["e2e-login"];
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    await browser.execute((relayPort) => {
      localStorage.setItem("anywh:profiles", JSON.stringify([{ id: "e2e-login", label: "Login", host: "127.0.0.1", relayPort, colorIndex: 0 }]));
      localStorage.setItem("anywh:last-profile", "e2e-login");
      localStorage.removeItem("anywh:tabs");
      localStorage.removeItem("anywh:tab-layout");
      localStorage.removeItem("anywh:session-list-cache");
      localStorage.removeItem("anywh:locale");
      window.location.reload();
    }, port);
  });

  after(async () => {
    await browser.execute((saved) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    }, previous);
    await machine?.stop();
  });

  it("a new conversation whose agent has no login says so above the composer", async () => {
    const newConversation = await $('[aria-label="New session"]');
    await newConversation.waitForExist({ timeout: 15000 });
    await newConversation.click();
    const strip = await $("[data-agent-signed-out]");
    await strip.waitForExist({ timeout: 30000 });
    const text = await strip.getText();
    if (!text.includes("Claude Code isn't signed in on this profile.")) throw new Error(`the strip says: ${text}`);
    await shot("agent-login-01-chat-strip");
  });

  it("Connect opens the sign-in: the provider's page to open, and a field for its code", async () => {
    await (await $("[data-agent-signed-out]")).$("button").click();
    const link = await $('//a[contains(normalize-space(.), "Open sign-in page")]');
    await link.waitForExist({ timeout: 20000 });
    const href = await link.getAttribute("href");
    if (!href?.startsWith("https://claude.com/cai/oauth/authorize")) throw new Error(`the sign-in page is ${String(href)}`);
    await $("#agent-login-code").waitForExist({ timeout: 5000 });
    await shot("agent-login-02-dialog-prompt");
  });

  it("the pasted code signs Claude in, and the strip goes away", async () => {
    await browser.execute(() => {
      const input = document.querySelector("#agent-login-code");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "good-code");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = await $('//button[@type="submit" and normalize-space()="Connect"]');
    await submit.waitForEnabled({ timeout: 5000 });
    await submit.click();
    await byText("Connected as fake@anywh.test").waitForExist({ timeout: 20000 });
    await shot("agent-login-03-dialog-connected");

    await $('//button[normalize-space()="Done"]').click();
    // The relay re-reads the login after a sign-in; the plan usage it pushes
    // no longer says signed out.
    await $("[data-agent-signed-out]").waitForExist({ timeout: 30000, reverse: true });
    await shot("agent-login-04-chat-after");
  });

  it("the profile's accounts show the account it signed in to", async () => {
    await openSettings();
    await byText("Connected as fake@anywh.test · pro").waitForExist({ timeout: 20000 });
    await $('//button[normalize-space()="Switch account"]').waitForExist({ timeout: 5000 });
    await shot("agent-login-05-accounts");
    await browser.keys("Escape");
  });
});
