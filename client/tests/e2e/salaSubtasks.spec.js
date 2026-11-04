import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { roomMarker, startRoomRelay } from "./fixtures/roomRelay.mjs";

// A worker's native subagents on the room canvas, against a real relay, a real
// agent host and the fake `claude`, in the real Tauri window: they are drawn
// as mini-cards under the worker, linked to it by dashed elbows, one can be
// stopped alone, and opening one shows it in its parent's panel. The worker is
// told over the principal's socket to delegate, as sala.spec.js does, since
// this driver cannot type into the composer.
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

async function say(port, roomId, text) {
  const sent = await browser.executeAsync(
    (relayPort, id, message, done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/?session=${id}`);
      ws.onmessage = (event) => {
        if (JSON.parse(event.data).type !== "caught_up") return;
        ws.send(JSON.stringify({ type: "user_message", text: message }));
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
  );
  if (!sent) throw new Error("could not reach the room's principal");
}

/** A plain click: this driver delivers no pointerdown, which the mini-card's drag would take. */
const press = async (selector) => {
  const element = await $(selector);
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
};

const minis = () => $$(".sala-sub[data-subtask-id]");
const miniClass = (taskId) => browser.execute((id) => document.querySelector(`[data-subtask-id="${id}"]`)?.className ?? "", taskId);

describe("anywh room canvas — subtasks", () => {
  let stack;
  let roomId;
  let workerId;
  let previous;
  const gate = () => join(stack.dir, "gate");

  before(async () => {
    stack = await startRoomRelay();
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    await browser.execute(
      (port) => {
        localStorage.setItem("anywh:profiles", JSON.stringify([{ id: "e2e-room", label: "Room relay", host: "127.0.0.1", relayPort: port }]));
        localStorage.removeItem("anywh:tabs");
        localStorage.removeItem("anywh:tab-layout");
        localStorage.removeItem("anywh:session-list-cache");
        window.location.reload();
      },
      stack.port,
    );
    await $('[aria-label="New session"]').waitForExist({ timeout: 30000 });
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Auth refactor" }),
    });
    roomId = (await created.json()).roomId;
    await browser.execute(
      (id) => {
        localStorage.setItem("anywh:tabs", JSON.stringify([{ id, profileId: "e2e-room", title: "Auth refactor", room: true }]));
        localStorage.setItem("anywh:active-tab", id);
        localStorage.removeItem("anywh:tab-layout");
        window.location.reload();
      },
      roomId,
    );
    await $('[data-testid="sala-canvas"]').waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await $$("[data-agent-id]")).length === 1, { timeout: 30000 });
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

  it("draws a worker's subagents as mini-cards under it, each linked by a dashed elbow", async () => {
    // One subagent that has finished and two that keep running; the gate holds
    // the worker's own turn open so that it stays at work.
    const task = `Refactor the auth middleware\n[[subagents:done,run,run]]\n[[gate:${gate()}]]`;
    await say(stack.port, roomId, roomMarker("delegate", { task, runtime: "claude", model: "haiku" }));
    await browser.waitUntil(async () => (await minis()).length === 3, { timeout: 60000, timeoutMsg: "the subtasks never showed as mini-cards" });

    const members = (await (await fetch(`${stack.base}/rooms/${roomId}`)).json()).members;
    workerId = members.find((m) => m.room.role === "worker").id;
    const parent = await $(`[data-agent-id="${workerId}"]`);
    for (const mini of await minis()) expect(await parent.$(`[data-subtask-id="${await mini.getAttribute("data-subtask-id")}"]`).isExisting()).toBe(true);

    const edges = await browser.execute((id) => [...document.querySelectorAll(`[data-sub-edge="${id}"]`)].map((p) => ({ d: p.getAttribute("d"), dash: getComputedStyle(p).strokeDasharray })), workerId);
    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      // The links between agents are straight elbows; these are the same, dashed.
      expect(edge.d).toMatch(/^M[\d. -]+V[\d. -]+H[\d. -]+V[\d. -]+$/);
      expect(edge.dash).not.toBe("none");
    }
    // The finished one reads as done, the other two as running.
    const states = await browser.execute(() => [...document.querySelectorAll(".sala-sub[data-subtask-id]")].map((el) => el.className));
    expect(states.filter((c) => c.includes("done"))).toHaveLength(1);
    expect(states.filter((c) => c.includes("run"))).toHaveLength(2);
    await browser.waitUntil(() => browser.execute(() => document.querySelector(".sala-world").classList.contains("moving") === false), { timeout: 20000 });
    await shot("subtask-minicards-dark");
  });

  it("selects a mini-card with a click and stops that subtask from its bar, leaving the others and the worker going", async () => {
    const running = await browser.execute(() => [...document.querySelectorAll(".sala-sub.run[data-subtask-id]")].map((el) => el.getAttribute("data-subtask-id")));
    expect(running).toHaveLength(2);
    const [target, other] = running;
    await press(`[data-subtask-id="${target}"] .sala-sub-hit`);
    const bar = await $(`[data-subtask-id="${target}"] .sala-bar`);
    await bar.waitForExist({ timeout: 15000, timeoutMsg: "the mini-card's bar never opened" });
    // The same bar a card has, with only what applies: no way to delegate or remove a subtask.
    await expect(bar).toHaveText(expect.stringContaining("Open conversation"));
    await expect(bar).not.toHaveText(expect.stringContaining("Delegate"));
    await shot("subtask-minicards-selected");
    await press(`//*[@data-subtask-id="${target}"]//*[contains(@class, "sala-bar")]//button[contains(., "Stop")]`);
    await browser.waitUntil(async () => (await miniClass(target)).includes("stop"), { timeout: 20000, timeoutMsg: "the stopped subtask never showed as stopped" });
    expect(await miniClass(other)).toContain("run");
    expect(await browser.execute((id) => document.querySelector(`[data-agent-id="${id}"]`)?.getAttribute("data-state"), workerId)).toBe("working");
    const listed = await (await fetch(`${stack.base}/rooms/${roomId}/agents/${workerId}/subtasks`)).json();
    expect(listed.subtasks.find((t) => t.taskId === target).status).toBe("stopped");
    await shot("subtask-minicards-stopped");
  });

  it("lists the subtasks in the parent's panel without a way to stop them, and a row selects its mini-card with its bar open", async () => {
    const taskId = await browser.execute(() => document.querySelector(".sala-sub.run[data-subtask-id]").getAttribute("data-subtask-id"));
    // The panel opens from the bar of a mini-card, which opens its parent's conversation.
    await press(`[data-subtask-id="${taskId}"] .sala-sub-hit`);
    await press(`//*[@data-subtask-id="${taskId}"]//*[contains(@class, "sala-bar")]//button[contains(., "Open conversation")]`);
    const row = await $(`[data-subtask-row="${taskId}"]`);
    await row.waitForExist({ timeout: 15000, timeoutMsg: "the parent's panel never listed the subtask" });
    await browser.waitUntil(() => browser.execute(() => (document.querySelector('aside[data-panel="agent"]')?.getBoundingClientRect().width ?? 0) >= 383), { timeout: 10000, timeoutMsg: "the agent's panel never finished opening" });
    // No stop in the rows: that is the mini-card's bar.
    expect(await browser.execute(() => [...document.querySelectorAll("[data-subtask-row]")].some((el) => /Stop/.test(el.textContent ?? "") || el.querySelector("button") !== null))).toBe(false);
    // Pick another row than the selected mini-card: the canvas moves its selection.
    const done = await browser.execute(() => document.querySelector(".sala-sub.done[data-subtask-id]").getAttribute("data-subtask-id"));
    await press(`[data-subtask-row="${done}"]`);
    await $(`[data-subtask-id="${done}"] .sala-bar`).waitForExist({ timeout: 15000, timeoutMsg: "the row did not open the mini-card's bar" });
    expect(await miniClass(done)).toContain("sel");
    expect(await miniClass(taskId)).not.toContain("sel");
    await shot("subtask-minicards-panel");
  });

  it("lets the mini-cards go once the worker is over and nothing runs", async () => {
    // Let the worker's turn end, then stop what still runs.
    await fetch(`${stack.base}/rooms/${roomId}/agents/${workerId}/subtasks`).then((r) => r.json()).then(async ({ subtasks }) => {
      for (const t of subtasks.filter((s) => s.status === "running")) await fetch(`${stack.base}/rooms/${roomId}/agents/${workerId}/subtasks/${t.taskId}/stop`, { method: "POST" });
    });
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(gate(), ""));
    await browser.waitUntil(async () => (await minis()).length === 0, { timeout: 60000, timeoutMsg: "the mini-cards stayed after the worker was over" });
  });
});
