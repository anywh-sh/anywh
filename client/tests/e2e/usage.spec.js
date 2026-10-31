import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startPlanUsageMachine } from "./fixtures/planUsageRelay.mjs";

// Plan usage in the real Tauri window, against two real relays (one per
// profile) with the fake `claude`: the status bar's indicator, its card, the
// refresh that forces a probe, the other profile shown only in the card, the
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

/** The status bar's items, left to right, as boxes — to prove the indicator
 * comes first and that nothing overlaps at the current width. */
function statusBarLayout() {
  return browser.execute(() => {
    const bar = document.querySelector("[data-status-bar]");
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    const items = Array.from(bar?.children ?? [])
      .map((element) => ({ ...box(element), usage: element.hasAttribute("data-usage-slot"), status: element.getAttribute("role") === "status" }))
      .filter((item) => item.width > 0);
    return { items, scrollWidth: bar?.scrollWidth ?? 0, clientWidth: bar?.clientWidth ?? 0 };
  });
}

function assertLayout(layout, where) {
  if (!layout.items[0]?.usage) throw new Error(`${where}: the usage indicator is not the status bar's first item`);
  for (let i = 1; i < layout.items.length; i++) {
    if (layout.items[i].left < layout.items[i - 1].right - 0.5) throw new Error(`${where}: status bar items overlap at ${String(i)}: ${JSON.stringify(layout.items)}`);
  }
  if (layout.scrollWidth > layout.clientWidth + 1) throw new Error(`${where}: the status bar overflows (${String(layout.scrollWidth)} > ${String(layout.clientWidth)})`);
}
const card = () => $("[data-usage-card]");
const label = (element) => element.getAttribute("aria-label");

describe("plan usage", () => {
  let machine;
  let pessoal;
  let trabalho;
  let previous;

  before(async () => {
    machine = await startPlanUsageMachine([
      // Codex: a login lost on Pessoal (it was used there once), never made
      // on Trabalho.
      { id: "e2e-pessoal", label: "Pessoal", fiveHour: 0.58, sevenDay: 0.41, codexUsedBefore: true },
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
    // known active window); Codex is installed with its login lost.
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
    await browser.waitUntil(async () => /^Usage: Claude Code 58% 5h; Codex not signed in$/.test(await label(indicator())), {
      timeout: 20000,
      timeoutMsg: "the indicator never showed the probed reading",
    });
    // Read in one pass inside the webview: the card's meters, its profile
    // order and the login commands it offers.
    const seen = await browser.execute(() => {
      const root = document.querySelector("[data-usage-card]");
      const all = (selector, read) => Array.from(root?.querySelectorAll(selector) ?? []).map(read);
      return {
        meters: all('[role="meter"]', (meter) => meter.getAttribute("aria-valuenow")).join(","),
        order: all("[data-usage-profile]", (section) => section.getAttribute("data-usage-profile")).join(","),
        lost: all("[data-usage-profile] [data-usage-signed-out] code", (code) => code.closest("[data-usage-profile]").getAttribute("data-usage-profile") + ":" + code.textContent).join(","),
        notUsed: all("[data-usage-not-used] code", (code) => code.closest("[data-usage-profile]").getAttribute("data-usage-profile") + ":" + code.textContent).join(","),
      };
    });
    if (seen.meters !== "58,41,91,64") throw new Error(`card meters: expected 58,41,91,64, got ${seen.meters}`);
    if (seen.order !== "e2e-pessoal,e2e-trabalho") throw new Error(`profiles out of order: ${seen.order}`);
    // A lost login gets the orange strip; an agent never used on the
    // profile, one quiet line — both with the command.
    if (seen.lost !== "e2e-pessoal:codex login") throw new Error(`lost-login strips: ${seen.lost}`);
    if (seen.notUsed !== "e2e-trabalho:codex login") throw new Error(`never-used lines: ${seen.notUsed}`);
    // On the left: flush with the window's left edge, above the indicator,
    // its border on the top and right only. Measured once the popover has
    // re-placed itself for the content that just arrived (and the 140ms
    // rise is over).
    await browser.pause(500);
    const placement = await browser.execute(() => {
      const card = document.querySelector("[data-usage-card]");
      const style = card ? getComputedStyle(card) : null;
      return {
        left: card?.getBoundingClientRect().left,
        bottom: card?.getBoundingClientRect().bottom,
        barTop: document.querySelector("[data-status-bar]")?.getBoundingClientRect().top,
        borderLeft: style?.borderLeftWidth,
        borderRight: style?.borderRightWidth,
      };
    });
    if (placement.left !== 0) throw new Error(`the card should touch the window's left edge, left = ${String(placement.left)}`);
    if (Math.abs(placement.bottom - placement.barTop) > 1) throw new Error(`the card should sit on the status bar: ${JSON.stringify(placement)}`);
    if (placement.borderLeft !== "0px" || placement.borderRight === "0px") throw new Error(`the card's borders should be top and right: ${JSON.stringify(placement)}`);
    await shot("eng-39-e2e-card");
  });

  it("puts the indicator first on the left, with the relay status still on the right", async () => {
    const layout = await statusBarLayout();
    assertLayout(layout, "1440px");
    const status = layout.items.find((item) => item.status);
    if (!status || status.right < layout.clientWidth / 2) throw new Error("the relay status left the right side of the bar");
  });

  it("closes on Escape and gives focus back to the indicator", async () => {
    await browser.keys("Escape");
    await card().waitForExist({ timeout: 5000, reverse: true });
    const focused = await browser.execute(() => document.activeElement?.hasAttribute("data-usage-indicator") ?? false);
    if (!focused) throw new Error("focus did not return to the indicator");
    await shot("eng-39-e2e-statusbar");
  });
  it("refreshes from the status bar's own button, beside the indicator, without opening the card", async () => {
    const refresh = await $('[data-status-bar] button[aria-label="Refresh usage"]');
    await refresh.waitForExist({ timeout: 5000 });
    const sibling = await browser.execute(() => {
      const indicator = document.querySelector("[data-usage-indicator]");
      const button = document.querySelector('[data-status-bar] button[aria-label="Refresh usage"]');
      return Boolean(indicator && button && !indicator.contains(button) && indicator.parentElement === button.parentElement);
    });
    if (!sibling) throw new Error("the status bar's refresh button must be the indicator's sibling");
    // The forced refresh a moment ago keeps Claude inside the relay's 60s
    // floor, but Codex (no login, no floor) leaves the button free.
    const before = { pessoal: pessoal.probes().length, trabalho: trabalho.probes().length };
    await refresh.click();
    await browser.pause(500);
    if (await card().isExisting()) throw new Error("the status bar's refresh opened the card");
    const after = { pessoal: pessoal.probes().length, trabalho: trabalho.probes().length };
    if (after.pessoal !== before.pessoal || after.trabalho !== before.trabalho) {
      throw new Error(`a refresh inside Claude's floor probed again: ${JSON.stringify({ before, after })}`);
    }
    assertLayout(await statusBarLayout(), "1440px, refresh button");
    await shot("eng-39-refresh-statusbar");
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
    // Under 1024px the status bar keeps no refresh button (the card has one).
    if (await $('[data-status-bar] button[aria-label="Refresh usage"]').isExisting()) throw new Error("the compact status bar should have no refresh button");
    assertLayout(await statusBarLayout(), "980px");
    await shot("eng-39-e2e-statusbar-compact");
    // The narrowest the window goes: still first, still no overlap.
    await browser.setWindowSize(720, 700);
    await browser.pause(300);
    assertLayout(await statusBarLayout(), "720px");
    await shot("eng-39-e2e-statusbar-narrow");
    await browser.setWindowSize(1440, 900);
  });
});
