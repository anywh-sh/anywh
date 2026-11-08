import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { roomMarker, startRoomRelay } from "./fixtures/roomRelay.mjs";
import { FAKE_JIRA_SITE } from "./fixtures/integrationsRelay.mjs";

// Jira tickets in a room, in the real Tauri window, against a real relay, a
// real agent host and the fake `claude` with the Jira fakes
// (tests/e2e/fixtures/roomRelay.mjs with `jira`). The room's principal is
// given NGL-2 and delegates an agent with it — the message the app sends
// when "Work on it in a room…" puts the ticket on the principal's composer,
// sent here over the session socket because this driver cannot type (see
// sala.spec.js) — and is handed ABC-7, which it keeps. Then what the app
// draws of it: the worker's card with its ticket, the room's "Tickets in this
// room", and the ticket's screen naming "room › agent", which brings that
// agent forward on the canvas.
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

const PROFILE = "e2e-room-jira";
const ROOM_TITLE = "Release prep";

/** Says `text` to the room's principal over its session socket, carrying
 * `key` as the ticket the app's composer chip would send with it. */
async function say(port, roomId, text, key) {
  const sent = await browser.executeAsync(
    (relayPort, id, message, ticket, done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/?session=${id}`);
      ws.onmessage = (event) => {
        if (JSON.parse(event.data).type !== "caught_up") return;
        ws.send(JSON.stringify({ type: "user_message", text: message, startTicket: ticket }));
        setTimeout(() => {
          ws.close();
          done(true);
        }, 500);
      };
      ws.onerror = () => done(false);
    },
    port,
    roomId,
    text,
    { provider: "jira", site: FAKE_JIRA_SITE.id, key },
  );
  if (!sent) throw new Error("could not reach the room's principal");
}

const press = async (selector) => {
  const element = await $(selector);
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
};

/** Waits until the camera is at rest, so a photograph shows the room and not
 * a frame of a move. */
const cameraAtRest = () =>
  browser.waitUntil(() => browser.execute(() => !document.querySelector(".sala-world")?.classList.contains("moving")), {
    timeout: 15000,
    timeoutMsg: "the camera never came to rest",
  });

const paneSettled = (kind) =>
  browser.waitUntil(
    () =>
      browser.execute((pane) => {
        const box = document.querySelector(`[data-dock-pane="${pane}"]`)?.getBoundingClientRect();
        return box !== undefined && box.width >= 383 && box.right <= window.innerWidth + 1;
      }, kind),
    { timeout: 10000, timeoutMsg: `the ${kind} pane never finished opening` },
  );

describe("Jira tickets in a room", () => {
  let stack;
  let roomId;
  let workerId;
  let principalId;
  let previous;

  before(async () => {
    stack = await startRoomRelay({ jira: true, profile: { id: PROFILE, label: "Room relay" } });
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    await browser.execute(
      (id, port) => {
        localStorage.setItem("anywh:profiles", JSON.stringify([{ id, label: "Room relay", host: "127.0.0.1", relayPort: port }]));
        for (const key of ["anywh:tabs", "anywh:active-tab", "anywh:tab-layout", "anywh:session-dock", "anywh:session-list-cache", "anywh:locale"]) localStorage.removeItem(key);
        window.location.reload();
      },
      PROFILE,
      stack.port,
    );
    await $('[aria-label="New session"]').waitForExist({ timeout: 30000 });

    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: ROOM_TITLE }),
    });
    roomId = (await created.json()).roomId;
    // The worker stays at work until this file exists (never, here).
    const gate = join(stack.dir, "gate");
    await say(stack.port, roomId, roomMarker("delegate", { task: `Write the release notes\n[[gate:${gate}]]`, runtime: "claude", model: "haiku", area: "Docs", ticket: "NGL-2" }), "NGL-2");
    await say(stack.port, roomId, "Keep this one for later.", "ABC-7");
    const deadline = Date.now() + 60_000;
    for (;;) {
      const room = await (await fetch(`${stack.base}/rooms/${roomId}`)).json();
      const worker = room.members?.find((member) => member.room.role === "worker" && member.room.ticket?.key === "NGL-2");
      const principal = room.members?.find((member) => member.room.role === "principal");
      if (worker && principal?.room.carriedTickets?.includes("ABC-7")) {
        workerId = worker.id;
        principalId = principal.id;
        break;
      }
      if (Date.now() > deadline) throw new Error(`the worker was never delegated with NGL-2: ${JSON.stringify(room.members?.map((member) => member.room))}\n${stack.output.join("").slice(-2000)}`);
      await new Promise((done) => setTimeout(done, 200));
    }

    await browser.execute(
      (id, profile, title) => {
        localStorage.setItem("anywh:tabs", JSON.stringify([{ id, profileId: profile, title, room: true }]));
        localStorage.setItem("anywh:active-tab", id);
        window.location.reload();
      },
      roomId,
      PROFILE,
      ROOM_TITLE,
    );
    await $('[data-testid="sala-canvas"]').waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await $$("[data-agent-id]")).length === 2, { timeout: 30000, timeoutMsg: "the room's two cards never appeared" });
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
    await stack?.stop();
  });

  it("shows the ticket on the card of the agent delegated with it, and not on the principal's", async () => {
    const chip = await $(`[data-agent-id="${workerId}"] [data-testid="room-ticket-chip"]`);
    await chip.waitForExist({ timeout: 30000, timeoutMsg: "the worker's card never showed its ticket" });
    await expect(chip).toHaveAttribute("data-ticket", "NGL-2");
    if (await $(`[data-agent-id="${principalId}"] [data-testid="room-ticket-chip"]`).isExisting()) throw new Error("the principal's card shows a ticket");
    await cameraAtRest();
    await shot("jira-e2e-room-card-chip");
  });

  it("opens the ticket's screen from the card, naming the room and the agent that works on it", async () => {
    await press(`[data-agent-id="${workerId}"] [data-testid="room-ticket-chip"]`);
    await paneSettled("integration");
    const screen = await $('[data-testid="ticket-screen"]');
    await screen.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await screen.getText()).includes("Write the release notes"), { timeout: 30000, timeoutMsg: "NGL-2's screen never loaded" });
    const row = await $(`[data-testid="ticket-sessions"] [data-room-agent-link="${workerId}"]`);
    await row.waitForExist({ timeout: 15000, timeoutMsg: "the ticket's screen does not list the room's agent" });
    await expect(row).toHaveText(expect.stringContaining(`${ROOM_TITLE} ›`));
    await expect(await row.$("[data-agent-state]")).toHaveText("working");
    // Read once, the card's chip now has the ticket's status too.
    await $(`[data-agent-id="${workerId}"] [data-testid="room-ticket-chip"] [data-status-category]`).waitForExist({ timeout: 15000 });
    await browser.execute((id) => document.querySelector(`[data-room-agent-link="${id}"]`)?.scrollIntoView({ block: "center" }), workerId);
    await shot("jira-e2e-room-ticket-screen");
  });

  it("brings the agent forward on the canvas when its row on the ticket's screen is clicked", async () => {
    if (await browser.execute((id) => document.querySelector(`[data-agent-id="${id}"]`)?.classList.contains("sel"), workerId)) throw new Error("the card was selected before the row was clicked");
    await press(`[data-room-agent-link="${workerId}"]`);
    await browser.waitUntil(() => browser.execute((id) => document.querySelector(`[data-agent-id="${id}"]`)?.classList.contains("sel") === true, workerId), {
      timeout: 15000,
      timeoutMsg: "the agent's card was never selected",
    });
    // Its conversation opens beside the canvas, and the camera shows its card.
    await $('button[aria-label="Close agent conversation"]').waitForExist({ timeout: 15000, timeoutMsg: "the agent's conversation never opened" });
    await cameraAtRest();
    const inView = await browser.execute((id) => {
      const viewport = document.querySelector('[data-testid="sala-canvas"]').getBoundingClientRect();
      const card = document.querySelector(`[data-agent-id="${id}"]`).getBoundingClientRect();
      return card.left >= viewport.left - 1 && card.right <= viewport.right + 1 && card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1;
    }, workerId);
    if (!inView) throw new Error("the agent's card is not in view");
    // Its action bar too, which is wider than the card.
    const barInView = await browser.execute(() => {
      const viewport = document.querySelector('[data-testid="sala-canvas"]').getBoundingClientRect();
      const bar = document.querySelector('.sala-bar[role="toolbar"]')?.getBoundingClientRect();
      return bar !== undefined && bar.left >= viewport.left - 1 && bar.right <= viewport.right + 1 && bar.top >= viewport.top - 1;
    });
    if (!barInView) throw new Error("the selected card's action bar is cut off by the canvas's edge");
    // The bar fades in, and the webview paints it a beat later still.
    await browser.pause(1000);
    await shot("jira-e2e-room-row-focus");
  });

  it("lists the room's tickets in its About: the agent's, and the one the principal keeps", async () => {
    await press('[data-testid="dock-rail"] button[aria-label="About this room"]');
    await paneSettled("about");
    const delegated = await $('[data-room-ticket="NGL-2"]');
    await delegated.waitForExist({ timeout: 15000, timeoutMsg: "About does not list NGL-2" });
    await expect(await $('//*[contains(text(), "Tickets in this room")]')).toBeExisting();
    await expect(await $('[data-room-ticket="ABC-7"]')).toHaveText(expect.stringContaining("with the principal"));
    await shot("jira-e2e-room-about-tickets");
  });
});
