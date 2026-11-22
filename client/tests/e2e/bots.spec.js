import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { roomMarker, startRoomRelay } from "./fixtures/roomRelay.mjs";

// Bots against a real relay, a real agent host and the fake `claude` (the
// relay's sanctioned test boundary), in the real Tauri window. A bot is
// created from a template over HTTP and spoken to over its session socket
// from inside the webview (this driver cannot type into the composer, see
// composer.spec.js); what is proven here is the shell around it in the real
// engine: the Bots section of the sidebar, the bot's tab with its task panel,
// a question answered from the panel, and a schedule run from it.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

/** Says `text` to the bot over its session socket and waits for its turn to end. */
async function say(port, roomId, text) {
  const sent = await browser.executeAsync(
    (relayPort, id, message, done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/?session=${id}`);
      let sentIt = false;
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "caught_up" && !sentIt) {
          sentIt = true;
          ws.send(JSON.stringify({ type: "user_message", text: message }));
        }
        if (sentIt && data.type === "agent_event" && data.event.type === "turn_ended") {
          ws.close();
          done(true);
        }
      };
      ws.onerror = () => done(false);
    },
    port,
    roomId,
    text,
  );
  if (!sent) throw new Error("could not reach the bot");
}

async function botIdle(base, id) {
  await browser.waitUntil(async () => !(await (await fetch(`${base}/bots`)).json()).bots.find((bot) => bot.id === id)?.busy, { timeout: 20000, timeoutMsg: "the bot never went idle" });
}

describe("bots", () => {
  let stack;
  let previous;
  let bot;

  before(async () => {
    stack = await startRoomRelay({ digestWindowMs: 50 });
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    const created = await fetch(`${stack.base}/bots`, {
      method: "POST",
      body: JSON.stringify({
        name: "Vigia",
        soul: "I watch the CI.\n\n## Never\n- Merge.",
        templateId: "ci-check",
        agentId: "claude",
        model: "haiku",
        cwd: stack.dir,
        schedules: [{ name: "CI check", cron: "0 9-18 * * 1-5", prompt: "[[look-then-silent]]", paused: true }],
      }),
    });
    bot = (await created.json()).bot;
    await botIdle(stack.base, bot.id);
    await browser.execute(
      (port) => {
        localStorage.setItem("anywh:profiles", JSON.stringify([{ id: "e2e-bots", label: "Bots relay", host: "127.0.0.1", relayPort: port }]));
        localStorage.setItem("anywh:right-panel-open", "true");
        localStorage.removeItem("anywh:tabs");
        localStorage.removeItem("anywh:tab-layout");
        localStorage.removeItem("anywh:session-list-cache");
        window.location.reload();
      },
      stack.port,
    );
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

  it("lists the bot in the Bots group, open above the conversations", async () => {
    const row = await $('[aria-label="Vigia"]');
    await row.waitForExist({ timeout: 30000 });
    await expect(row).toHaveText(expect.stringContaining("setting up"));
    const bots = await $('//button[@aria-expanded="true"][contains(., "Bots")]');
    await expect(bots).toExist();
    await shot("bots-01-sidebar");
  });

  it("opens the bot as a conversation whose side panel is its task list", async () => {
    await say(stack.port, bot.roomId, `plan ${roomMarker("task_create", { title: "Fix the flaky relay test", done_means: "20 green runs" })} ${roomMarker("task_ask", { task: 1, question: "Retry per test or per job?", options: ["Per test", "Per job"], recommended: 0 })}`);
    await $('[aria-label="Vigia"]').click();
    const panel = await $('[data-testid="bot-panel"]');
    await panel.waitForExist({ timeout: 20000 });
    await browser.waitUntil(async () => (await panel.getText()).includes("Fix the flaky relay test"), { timeout: 15000, timeoutMsg: "the task never reached the panel" });
    await expect(panel).toHaveText(expect.stringContaining("Needs you"));
    await shot("bots-02-panel");
  });

  it("answers the task's question from the panel, and the bot gets the answer", async () => {
    await $('//*[@data-testid="bot-panel"]//*[contains(text(), "Fix the flaky relay test")]').click();
    const detail = await $('[data-testid="bot-task-detail"]');
    await detail.waitForExist({ timeout: 10000 });
    await detail.$('//*[contains(text(), "Per job")]').click();
    await detail.$('[aria-label="Send answers"]').click();
    await browser.waitUntil(
      async () => {
        const view = (await (await fetch(`${stack.base}/bots/${bot.id}`)).json()).bot;
        return view.tasks[0].question === undefined && view.tasks[0].notes.some((note) => note.text === "Answered: Per job");
      },
      { timeout: 15000, timeoutMsg: "the answer never reached the relay" },
    );
    await shot("bots-03-answered");
  });

  it("turns a schedule on and runs it now from the panel; a run with nothing to say stays silent", async () => {
    await $('//*[@data-testid="bot-task-detail"]//button[contains(., "Tasks")]').click();
    const schedule = await $('[data-testid="bot-schedule"]');
    await schedule.waitForExist({ timeout: 10000 });
    await schedule.$('[role="switch"]').click();
    await browser.waitUntil(async () => !(await (await fetch(`${stack.base}/bots/${bot.id}`)).json()).bot.schedules[0].paused, { timeout: 10000, timeoutMsg: "the schedule never turned on" });
    await schedule.$('[aria-label="Run now"]').click();
    await browser.waitUntil(async () => (await (await fetch(`${stack.base}/bots/${bot.id}`)).json()).bot.schedules[0].runs[0]?.outcome === "silent", { timeout: 20000, timeoutMsg: "the run never ended silent" });
    await shot("bots-04-schedule");
  });
});
