import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateE2EFixtures } from "../../wdio.conf.js";
import { FAKE_JIRA_SITE, startIntegrationsRelay } from "./fixtures/integrationsRelay.mjs";

// Jira in the real Tauri window, against a real relay whose agents' MCP
// servers are the fakes' (tests/e2e/fixtures/integrationsRelay.mjs): Claude
// reads Jira through `claude.ai Atlassian`, Codex has the official server
// but is not signed in. The rail's Jira button, the pane's "All mine" list,
// a project picked and remembered by the relay, a ticket's screen, Codex
// signed in from the connect card, and the two ways a ticket meets a
// session: "New session" on its screen, and a session already working on
// one. Nothing in the app is stubbed.
//
// Two edges are driven the way this driver allows (.anywh/skills/tests/
// SKILL.md): a Radix dropdown opens with Enter on its focused trigger, and
// the composer cannot be typed into — the session that works on a ticket is
// started by the fixture, over the session socket, with the message the
// app's first send would carry. The browser of the sign-in is the fake
// `xdg-open` (it records the address); the browser coming back to the app is
// the deep-link plugin's own event, `deep-link://new-url`, emitted from the
// webview with the callback address — the event `onOpenUrl` listens to, and
// what the plugin emits when the OS hands the app an `anywh://` link (a
// second process launched with that link would need the session bus, which
// a CI runner does not have).
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

const PROFILE = "e2e-jira";
/** The session the fixture starts on NGL-1 before the app opens. */
const WORKED = "e2e-jira-worked";

/** The one element of `selector` that is on screen: every tab stays
 * mounted, the hidden ones under an `invisible` ancestor. */
async function visible(selector, timeout = 15000) {
  let found;
  await browser.waitUntil(
    async () => {
      for (const element of await $$(selector)) {
        if (await element.isDisplayed()) {
          found = element;
          return true;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: `nothing on screen matches ${selector}` },
  );
  return found;
}

const press = async (selector) => {
  const element = await visible(selector);
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
};

/** Waits for the dock's pane to be open at its full width, so a photograph
 * shows the pane and not a frame of it. */
const paneSettled = () =>
  browser.waitUntil(
    () =>
      browser.execute(() =>
        [...document.querySelectorAll('[data-dock-pane="integration"]')].some((pane) => {
          const box = pane.getBoundingClientRect();
          return box.width >= 383 && box.right <= window.innerWidth + 1;
        }),
      ),
    { timeout: 10000, timeoutMsg: "the side panel never finished opening" },
  );

/** The keys of the ticket rows on screen, top to bottom. */
const listedKeys = () =>
  browser.execute(() =>
    [...document.querySelectorAll('[data-testid="ticket-list"] [data-ticket]')].filter((row) => row.getBoundingClientRect().width > 0).map((row) => row.getAttribute("data-ticket")),
  );

/** The relay's own view of the integration (GET /integrations). */
const relayJira = async (base) => (await (await fetch(`${base}/integrations`)).json()).integrations.find((integration) => integration.id === "jira");

const openedUrls = () => (existsSync(updateE2EFixtures.openedUrlsLog) ? readFileSync(updateE2EFixtures.openedUrlsLog, "utf8").split("\n").filter(Boolean) : []);

describe("Jira integration", () => {
  let relay;
  let previous;

  before(async () => {
    relay = await startIntegrationsRelay({ id: PROFILE, label: "Work", pageSize: 3 });
    await relay.startSessionOnTicket(WORKED, "NGL-1", "The login redirect loops on Safari", "Login redirect loop");
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    await browser.execute(
      (id, port) => {
        localStorage.setItem("anywh:profiles", JSON.stringify([{ id, label: "Work", host: "127.0.0.1", relayPort: port, colorIndex: 0 }]));
        localStorage.setItem("anywh:last-profile", id);
        for (const key of ["anywh:tabs", "anywh:active-tab", "anywh:tab-layout", "anywh:session-dock", "anywh:session-list-cache", "anywh:locale"]) localStorage.removeItem(key);
        window.location.reload();
      },
      PROFILE,
      relay.port,
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
    await relay?.stop();
  });

  it("puts Jira on the side panel's rail, between the divider and +, marked for the agent that has to connect", async () => {
    await press('[aria-label="New session"]');
    const jira = await visible('[data-testid="dock-rail"] button[data-integration="jira"]', 30000);
    await browser.waitUntil(async () => (await jira.getAttribute("aria-label")) === "Jira · 1 agent needs to connect", {
      timeout: 30000,
      timeoutMsg: "the rail never said one agent has to connect to Jira",
    });
    await expect(await jira.$('[data-rail-badge="needs_auth"]')).toBeExisting();
    // Under the divider, right before the "+".
    const order = await browser.execute(() => {
      const rail = [...document.querySelectorAll('[data-testid="dock-rail"]')].find((element) => element.getBoundingClientRect().width > 0);
      const button = rail?.querySelector('button[data-integration="jira"]');
      const next = button?.nextElementSibling;
      return { next: next?.getAttribute("aria-label") ?? next?.textContent ?? null, top: button?.getBoundingClientRect().top ?? 0, height: rail?.getBoundingClientRect().height ?? 0 };
    });
    if (!/add/i.test(order.next ?? "")) throw new Error(`the Jira button is not right before the rail's +: ${JSON.stringify(order)}`);
    await shot("jira-e2e-rail");
  });

  it("opens the pane on All mine, with no done ticket, and loads the next page", async () => {
    await press('[data-testid="dock-rail"] button[data-integration="jira"]');
    await paneSettled();
    const header = await visible('[data-testid="integration-panel-header"]');
    await browser.waitUntil(async () => (await header.getText()).includes(FAKE_JIRA_SITE.host), { timeout: 30000, timeoutMsg: "the pane never named the site" });
    const dropdown = await visible('[data-testid="project-dropdown"]');
    await expect(dropdown).toHaveText("All mine");
    // Newest change first, three to a page; NGL-3 is done.
    await browser.waitUntil(async () => (await listedKeys()).join(",") === "NGL-2,NGL-1,ABC-7", {
      timeout: 30000,
      timeoutMsg: async () => `the list never showed the first page: ${(await listedKeys()).join(",")}`,
    });
    // The session the fixture started is on NGL-1's row.
    await visible('[data-ticket="NGL-1"] [data-session-chip="e2e-jira-worked"]');
    // Codex has to sign in: one line, not the big notice — Claude reads.
    const notice = await visible('[data-testid="integration-connect-notice"]');
    await expect(notice).toHaveText(expect.stringContaining("1 agent needs to connect to Jira"));
    // The rail button keeps the click's focus, and its tooltip with it.
    await browser.execute(() => document.activeElement?.blur());
    await shot("jira-e2e-panel-list");

    await press('//button[normalize-space(.)="Load more"]');
    await browser.waitUntil(async () => (await listedKeys()).join(",") === "NGL-2,NGL-1,ABC-7,NGL-4", { timeout: 20000, timeoutMsg: "Load more never added the second page" });
    await browser.waitUntil(async () => !(await $('//button[normalize-space(.)="Load more"]').isExisting()), { timeout: 10000, timeoutMsg: "Load more stayed after the last page" });
    if ((await listedKeys()).includes("NGL-3")) throw new Error("a done ticket is listed");
    await shot("jira-e2e-panel-all-loaded");
  });

  it("switches to one project from the dropdown, and the relay remembers it", async () => {
    // A Radix dropdown opens on pointerdown, which this driver never sends:
    // Enter on the focused trigger (SKILL.md).
    await browser.execute(() => [...document.querySelectorAll('[data-testid="project-dropdown"]')].find((element) => element.getBoundingClientRect().width > 0)?.focus());
    await browser.keys("Enter");
    const menu = await visible('[role="menu"]', 10000);
    await expect(menu).toHaveText(expect.stringContaining("every project"));
    await expect(menu).toHaveText(expect.stringContaining("ABC"));
    await expect(menu).toHaveText(expect.stringContaining("NGL"));
    await shot("jira-e2e-project-menu");
    await (await menu.$('//*[@role="menuitem"][normalize-space(.)="NGL"]')).click();
    await browser.waitUntil(async () => (await (await visible('[data-testid="project-dropdown"]')).getText()) === "NGL", { timeout: 10000, timeoutMsg: "the dropdown never showed NGL" });
    await browser.waitUntil(async () => (await listedKeys()).join(",") === "NGL-2,NGL-1,NGL-4", {
      timeout: 30000,
      timeoutMsg: async () => `the list never showed NGL's tickets: ${(await listedKeys()).join(",")}`,
    });
    await browser.waitUntil(async () => (await relayJira(relay.base))?.prefs?.project === "NGL", { timeout: 10000, timeoutMsg: "the relay never stored the project" });
    await shot("jira-e2e-panel-project");
  });

  it("opens a ticket's screen: title, key, priority, status, description, comments and its session", async () => {
    await press('[data-testid="ticket-list"] [data-ticket="NGL-1"]');
    const screen = await visible('[data-testid="ticket-screen"]');
    await browser.waitUntil(async () => (await screen.getText()).includes("Comment 12 on NGL-1"), { timeout: 30000, timeoutMsg: "the ticket's comments never came in" });
    const seen = await browser.execute(() => {
      const root = [...document.querySelectorAll('[data-testid="ticket-screen"]')].find((element) => element.getBoundingClientRect().width > 0);
      const text = root?.textContent ?? "";
      return {
        title: root?.querySelector("h2")?.textContent,
        heading: root?.querySelector('[data-testid="ticket-description"] h2')?.textContent ?? null,
        firstComment: text.indexOf("Comment 3 on NGL-1"),
        lastComment: text.indexOf("Comment 12 on NGL-1"),
        olderComment: text.includes("Comment 2 on NGL-1"),
        text,
        session: root?.querySelector('[data-session-link="e2e-jira-worked"]') !== null,
      };
    });
    if (seen.title !== "Fix the login redirect") throw new Error(`ticket title: ${String(seen.title)}`);
    if (seen.heading !== "Fix the login redirect") throw new Error("the description's markdown was not rendered");
    for (const words of ["NGL-1", "High", "In Progress", "Open in Jira", "NGL"]) if (!seen.text.includes(words)) throw new Error(`the ticket screen lacks "${words}"`);
    // The last ten comments, oldest first.
    if (seen.olderComment || seen.firstComment < 0 || seen.firstComment > seen.lastComment) throw new Error("the comments are not the last ten, oldest first");
    if (!seen.session) throw new Error("the session working on NGL-1 is not listed on its screen");
    await shot("jira-e2e-ticket");
    // Under the description: the sessions working on it.
    await browser.execute(() => [...document.querySelectorAll('[data-testid="ticket-sessions"]')].find((element) => element.getBoundingClientRect().width > 0)?.scrollIntoView({ block: "center" }));
    await shot("jira-e2e-ticket-sessions");
  });

  it("signs Codex in from the connect card: the browser opens and the app's link comes back to the relay", async () => {
    // Back to the list, whose notice opens the card.
    await press('//*[@data-testid="ticket-screen"]//button[normalize-space(.)="NGL"]');
    await press('[data-testid="integration-connect-notice"] button');
    const card = await visible('[data-testid="connect-card"]');
    await browser.waitUntil(async () => (await (await card.$('[data-testid="connect-status-claude"]')).getText()) === `connected · ${FAKE_JIRA_SITE.host}`, {
      timeout: 15000,
      timeoutMsg: "the card never showed Claude connected",
    });
    await expect(await card.$('[data-testid="connect-status-codex"]')).toHaveText("configured · not signed in");
    await shot("jira-e2e-connect-card");

    const before = openedUrls().length;
    await (await card.$('//*[@data-connect-row="codex"]//button[normalize-space(.)="Connect"]')).click();
    await browser.waitUntil(async () => (await (await card.$('[data-testid="connect-status-codex"]')).getText()) === "finish in the browser…", {
      timeout: 20000,
      timeoutMsg: "Codex's sign-in never reached the browser step",
    });
    // The card opened the sign-in page in the browser (the fake opener).
    let authUrl;
    await browser.waitUntil(
      () => {
        authUrl = openedUrls().slice(before).find((url) => url.startsWith("https://auth.example.test/authorize"));
        return authUrl !== undefined;
      },
      { timeout: 10000, timeoutMsg: "the card never opened the sign-in page" },
    );
    const auth = new URL(authUrl);
    const redirect = auth.searchParams.get("redirect_uri") ?? "";
    if (!/^anywh:\/\/mcp-oauth\/callback\/[a-z0-9]+$/.test(redirect)) throw new Error(`the sign-in does not come back to the app: ${redirect}`);
    await shot("jira-e2e-connect-waiting");

    // The browser, done, hands the app its link.
    const callback = `${redirect}?code=e2e-code&state=${auth.searchParams.get("state")}`;
    await browser.execute((url) => window.__TAURI__.event.emit("deep-link://new-url", [url]), callback);
    await browser.waitUntil(async () => (await (await card.$('[data-testid="connect-status-codex"]')).getText()) === `connected · ${FAKE_JIRA_SITE.host}`, {
      timeout: 30000,
      timeoutMsg: async () => `Codex never showed connected: ${await (await card.$('[data-testid="connect-status-codex"]')).getText()}`,
    });
    await expect(await card.$('[data-testid="connect-progress"]')).toHaveText("2 of 2");
    await shot("jira-e2e-connect-done");
    await browser.keys("Escape");
    await card.waitForExist({ timeout: 5000, reverse: true });
    // Nobody left to connect: the rail's mark and the pane's notice go.
    await browser.waitUntil(async () => (await (await visible('[data-testid="dock-rail"] button[data-integration="jira"]')).getAttribute("aria-label")) === "Jira", {
      timeout: 15000,
      timeoutMsg: "the rail kept its mark",
    });
    if (await $('[data-testid="integration-connect-notice"]').isDisplayed()) throw new Error("the pane still asks to connect");
  });

  it("starts a new session on a ticket: the new-session screen with the ticket beside the folder", async () => {
    await press('[data-testid="ticket-list"] [data-ticket="NGL-2"]');
    const screen = await visible('[data-testid="ticket-screen"]');
    await browser.waitUntil(async () => (await screen.getText()).includes("Write the release notes"), { timeout: 30000, timeoutMsg: "NGL-2's screen never loaded" });
    await expect(await visible('[data-testid="ticket-sessions"]')).toHaveText(expect.stringContaining("No session works on this yet."));
    await press('//*[@data-testid="ticket-work-actions"]//button[normalize-space(.)="New session"]');

    // Straight to the new-session screen of a new tab, no question asked.
    const chip = await visible('[data-testid="work-ticket-chip"][data-ticket="NGL-2"]');
    await visible('[role="radiogroup"][aria-label="Session type"]');
    if (await $('[role="dialog"]').isExisting()) throw new Error("a dialog came between the ticket and the new session");
    const place = await browser.execute((element) => {
      const folder = element.previousElementSibling;
      const a = folder?.getBoundingClientRect();
      const b = element.getBoundingClientRect();
      return {
        folder: folder?.querySelector("svg.lucide-folder") !== null && folder !== null,
        gap: a ? b.left - a.right : null,
        middle: a ? Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) : null,
      };
    }, chip);
    if (!place.folder || place.gap < 0 || place.gap > 16 || place.middle > 2) throw new Error(`the ticket chip is not beside the folder: ${JSON.stringify(place)}`);
    await expect(chip).toHaveText("NGL-2");
    await shot("jira-e2e-new-session-chip");
  });

  it("shows the work ticket of a started session in the same place, and the chip opens its screen", async () => {
    // The new tab's pane is on the list: NGL-1's screen lists the session.
    await paneSettled();
    await press('[data-testid="ticket-list"] [data-ticket="NGL-1"]');
    await press('[data-testid="ticket-sessions"] [data-session-link="e2e-jira-worked"]');
    const chip = await visible('[data-testid="work-ticket-chip"][data-ticket="NGL-1"]', 30000);
    const beside = await browser.execute((element) => element.previousElementSibling?.querySelector("svg.lucide-folder") !== null, chip);
    if (!beside) throw new Error("the work ticket chip is not beside the folder");
    // A started session's chip comes with its conversation, not a new-session screen.
    if (await (await $('[role="radiogroup"][aria-label="Session type"]')).isDisplayed()) throw new Error("the session opened on the new-session screen");
    await shot("jira-e2e-session-chip");

    // Its own tab has no pane open yet: the chip opens the ticket there.
    await (await chip.$('button[aria-label="Open NGL-1"]')).click();
    await paneSettled();
    const screen = await visible('[data-testid="ticket-screen"]');
    await browser.waitUntil(async () => (await screen.getText()).includes("Fix the login redirect"), { timeout: 15000, timeoutMsg: "the chip did not open NGL-1's screen" });
    await shot("jira-e2e-session-chip-opens-ticket");
  });
});
