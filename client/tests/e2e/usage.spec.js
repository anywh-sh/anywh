import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startPlanUsageMachine } from "./fixtures/planUsageRelay.mjs";

// Plan usage in the real Tauri window, against two real relays (one per
// profile) with the fake `claude`: the status bar's indicator, its card, the
// refresh that forces a probe, the alert for the inactive profile, the
// compact form and an agent with no login. The numbers come from the fake's
// `rate_limit_event`, read by the relay's own probe — nothing in the app is
// stubbed.
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

const indicator = () => $("[data-usage-indicator]");
const card = () => $("[data-usage-card]");
const label = (element) => element.getAttribute("aria-label");

describe("plan usage", () => {
  let machine;
  let pessoal;
  let trabalho;
  let previous;

  before(async () => {
    machine = await startPlanUsageMachine([
      { id: "e2e-pessoal", label: "Pessoal", fiveHour: 0.58, sevenDay: 0.41 },
      { id: "e2e-trabalho", label: "Trabalho", fiveHour: 0.91, sevenDay: 0.64 },
    ]);
    ({ "e2e-pessoal": pessoal, "e2e-trabalho": trabalho } = machine.relays);
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    await browser.execute(
      (a, b) => {
        localStorage.setItem(
          "anywh:profiles",
          JSON.stringify([
            { id: "e2e-pessoal", label: "Pessoal", host: "127.0.0.1", relayPort: a, colorIndex: 0 },
            { id: "e2e-trabalho", label: "Trabalho", host: "127.0.0.1", relayPort: b, colorIndex: 1 },
          ]),
        );
        localStorage.setItem("anywh:last-profile", "e2e-pessoal");
        localStorage.removeItem("anywh:tabs");
        localStorage.removeItem("anywh:tab-layout");
        localStorage.removeItem("anywh:session-list-cache");
        localStorage.removeItem("anywh:locale");
        window.location.reload();
      },
      pessoal.port,
      trabalho.port,
    );
    await $('[aria-label="New session"]').waitForExist({ timeout: 30000 });
  });

  after(async () => {
    if (previous) {
      await browser.execute((saved) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
        window.location.reload();
      }, previous);
      await $('[aria-label="New session"]').waitForExist({ timeout: 15000 });
    }
    await browser.setWindowSize(1440, 900);
    await machine?.stop();
  });

  it("shows the active profile's agents in the status bar, Codex with no login", async () => {
    await indicator().waitForExist({ timeout: 30000 });
    // Nothing probed Claude yet (the relay never probes on its own without a
    // known active window); Codex is installed with no login.
    await browser.waitUntil(async () => /Codex not signed in/.test(await label(indicator())), {
      timeout: 20000,
      timeoutMsg: "the indicator never said Codex has no login",
    });
    const button = await indicator();
    if ((await button.getAttribute("aria-haspopup")) !== "dialog") throw new Error("the indicator must announce a dialog");
    if ((await button.getAttribute("aria-expanded")) !== "false") throw new Error("the indicator must start collapsed");
    await shot("eng-39-e2e-statusbar-before-probe");
  });

  it("opens the card on click, and its refresh forces a probe on every relay", async () => {
    await (await indicator()).click();
    await card().waitForExist({ timeout: 10000 });
    if ((await (await indicator()).getAttribute("aria-expanded")) !== "true") throw new Error("aria-expanded did not follow the card");

    const before = { pessoal: pessoal.probes().length, trabalho: trabalho.probes().length };
    await (await (await card()).$('button[aria-label="Refresh usage"]')).click();
    await browser.waitUntil(() => pessoal.probes().length > before.pessoal && trabalho.probes().length > before.trabalho, {
      timeout: 20000,
      timeoutMsg: "refresh did not probe both relays",
    }).catch(async (error) => {
      await shot("eng-39-e2e-debug-refresh");
      const state = await browser.execute(() => document.querySelector("[data-usage-card] header")?.outerHTML);
      throw new Error(`${error.message}: probes ${JSON.stringify({ pessoal: pessoal.probes().length, trabalho: trabalho.probes().length, before })}\n${state}\n--- pessoal\n${pessoal.output.join("").slice(-1500)}\n--- trabalho\n${trabalho.output.join("").slice(-1500)}`);
    });

    // The probes' readings arrive by push: 58% here, 91% on the other profile.
    await browser.waitUntil(async () => /^Usage: Claude Code 58% 5h; Codex not signed in; Trabalho near the limit$/.test(await label(indicator())), {
      timeout: 20000,
      timeoutMsg: "the indicator never showed the probed reading and the alert",
    });
    // Read in one pass inside the webview: the card's meters, its profile
    // order and the login commands it offers.
    const seen = await browser.execute(() => {
      const root = document.querySelector("[data-usage-card]");
      const all = (selector, read) => Array.from(root?.querySelectorAll(selector) ?? []).map(read);
      return {
        meters: all('[role="meter"]', (meter) => meter.getAttribute("aria-valuenow")).join(","),
        order: all("[data-usage-profile]", (section) => section.getAttribute("data-usage-profile")).join(","),
        commands: all("[data-usage-signed-out] code", (code) => code.textContent).join(","),
      };
    });
    if (seen.meters !== "58,41,91,64") throw new Error(`card meters: expected 58,41,91,64, got ${seen.meters}`);
    if (seen.order !== "e2e-pessoal,e2e-trabalho") throw new Error(`profiles out of order: ${seen.order}`);
    if (seen.commands !== "codex login,codex login") throw new Error(`login commands: ${seen.commands}`);
    await browser.pause(300);
    await shot("eng-39-e2e-card");
  });

  it("alerts on the inactive profile near its limit", async () => {
    const alert = await $('[data-usage-alert="e2e-trabalho"]');
    if ((await alert.getAttribute("data-level")) !== "warn") throw new Error("expected a warn alert for Trabalho");
  });

  it("closes on Escape and gives focus back to the indicator", async () => {
    await browser.keys("Escape");
    await card().waitForExist({ timeout: 5000, reverse: true });
    const focused = await browser.execute(() => document.activeElement?.hasAttribute("data-usage-indicator") ?? false);
    if (!focused) throw new Error("focus did not return to the indicator");
    await shot("eng-39-e2e-statusbar");
  });

  it("keeps only the marks and the 5h percentage under 1024px", async () => {
    await browser.setWindowSize(980, 800);
    await browser.waitUntil(async () => !(await (await indicator()).getText()).includes("5h"), {
      timeout: 10000,
      timeoutMsg: "the indicator kept its wide form under 1024px",
    });
    const text = await (await indicator()).getText();
    if (!text.includes("58%")) throw new Error(`compact indicator lost the 5h percentage: "${text}"`);
    const meters = await browser.execute(() => document.querySelectorAll('[data-usage-indicator] [role="meter"]').length);
    if (meters !== 0) throw new Error("the compact indicator should draw no meter");
    await shot("eng-39-e2e-statusbar-compact");
    await browser.setWindowSize(1440, 900);
  });
});
