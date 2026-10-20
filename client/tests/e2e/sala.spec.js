import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { askMarker, roomMarker, startRoomRelay } from "./fixtures/roomRelay.mjs";

// The room canvas against a real relay, a real agent host and the fake
// `claude` (the relay's sanctioned test boundary), in the real Tauri window.
// The room is opened over HTTP and its principal is spoken to over the
// session socket from inside the webview, because this driver cannot type
// into the composer (see composer.spec.js): the new-session flow that needs
// typing is covered in client/tests/ui. What is proven here is what only a
// real engine can answer — the camera and the grid on a compositor, pointer
// gestures, the layout the relay keeps, a reload that finds it again.
//
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set (a folder outside
// the repo); otherwise the spec only takes them for the assertions that
// need pixels, none today.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await browser.saveScreenshot(join(SHOTS, `${name}.png`));
}

/** Says `text` to the room's principal over its session socket, as a person
 * typing in its conversation would. */
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

/** Synthetic pointer gesture on the canvas. A WebDriver pointer action does
 * not deliver pointerdown in this webview (see SKILL.md), so the gesture is
 * dispatched as the events a real pointer would produce. */
async function drag(selector, dx, dy) {
  await browser.execute(
    (sel, mx, my) => {
      const el = document.querySelector(sel);
      const vp = document.querySelector('[data-testid="sala-canvas"]');
      const r = el.getBoundingClientRect();
      const x = r.left + 40;
      const y = r.top + 20;
      const fire = (target, type, cx, cy) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 7, button: 0, isPrimary: true }));
      fire(el, "pointerdown", x, y);
      fire(vp, "pointermove", x + mx / 2, y + my / 2);
      fire(vp, "pointermove", x + mx, y + my);
      fire(vp, "pointerup", x + mx, y + my);
    },
    selector,
    dx,
    dy,
  );
}

/** Waits until the camera is at rest and every card is inside the viewport
 * (the canvas keeps the whole room in view as it grows), so that what is
 * measured or photographed is the room and not a frame of a move. */
async function roomInView() {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const vp = document.querySelector('[data-testid="sala-canvas"]').getBoundingClientRect();
        const moving = document.querySelector(".sala-world").classList.contains("moving");
        return (
          !moving &&
          [...document.querySelectorAll("[data-agent-id]")].every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= vp.left - 1 && r.right <= vp.right + 1 && r.top >= vp.top - 1 && r.bottom <= vp.bottom + 1;
          })
        );
      }),
    { timeout: 20000, timeoutMsg: "the camera never came to rest with the whole room in view" },
  );
}

/** Opens a room as the only tab and waits for its canvas. */
async function openRoomTab(id, title) {
  await browser.execute(
    (roomTab, name) => {
      localStorage.setItem("anywh:tabs", JSON.stringify([{ id: roomTab, profileId: "e2e-room", title: name, room: true }]));
      localStorage.setItem("anywh:active-tab", roomTab);
      localStorage.removeItem("anywh:tab-layout");
      window.location.reload();
    },
    id,
    title,
  );
  await $('[data-testid="sala-canvas"]').waitForExist({ timeout: 30000 });
}

/** A plain click, on elements that need no pointerdown (this driver does not deliver one). */
const press = async (selector) => {
  const element = await $(selector);
  await element.waitForClickable({ timeout: 15000 });
  await element.click();
};

/** Waits for the side panel to be open at its full width, so a
 * photograph shows the panel and not a frame of it. */
const panelSettled = () =>
  browser.waitUntil(() => browser.execute(() => (document.querySelector("aside.sala-side")?.getBoundingClientRect().width ?? 0) >= 383), { timeout: 10000, timeoutMsg: "the side panel never finished opening" });

/** A button of the selected card's action bar, by its words. */
const pressBar = async (words) => {
  const button = await $(`//*[contains(@class, "sala-bar")]//button[contains(., "${words}")]`);
  await button.waitForClickable({ timeout: 15000 });
  await button.click();
};

const cards = () => $$("[data-agent-id]");
const cardState = (id) => browser.execute((agent) => document.querySelector(`[data-agent-id="${agent}"]`)?.getAttribute("data-state"), id);
const savedCanvas = async (base, roomId) => (await (await fetch(`${base}/rooms/${roomId}/canvas`)).json()).canvas;

describe("anywh room canvas", () => {
  let stack;
  let roomId;
  let smallRoom;
  let previous;
  const gate = () => join(stack.dir, "gate");

  before(async () => {
    stack = await startRoomRelay();
    // Every spec file shares the app's data dir, and what the app writes while
    // it talks to this relay (the selected profile, tabs, model choices, the
    // session list) must not be there for the next one: all of it is put back.
    previous = await browser.execute(() => Object.fromEntries(Object.entries(localStorage)));
    await browser.setWindowSize(1440, 900);
    // The app talks to the relay started above.
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
  });

  after(async () => {
    if (previous) {
      await browser.execute((saved) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
        // The window outlives this file: left as it is, it would go on
        // showing the room (and its language) to the specs that follow.
        window.location.reload();
      }, previous);
      await $('[aria-label="New session"]').waitForExist({ timeout: 15000 });
    }
    await stack?.stop();
  });

  it("offers Conversation and Room on the new-session screen, and Room changes what the composer asks for", async () => {
    await $('[aria-label="New session"]').click();
    const group = await $('[role="radiogroup"][aria-label="Session type"]');
    await group.waitForExist({ timeout: 15000 });
    await expect(group).toHaveText(expect.stringContaining("Conversation"));
    await expect(group).toHaveText(expect.stringContaining("Room"));
    const conversation = await group.$('[role="radio"][aria-checked="true"]');
    await expect(conversation).toHaveText(expect.stringContaining("Conversation"));
    await shot("B-nova-sessao-conversa");
    await group.$('//*[@role="radio"][contains(., "Room")]').click();
    await browser.waitUntil(async () => (await (await group.$('[role="radio"][aria-checked="true"]')).getText()).includes("Room"), { timeout: 5000 });
    const hint = await $('.composer-editor p.is-editor-empty[data-placeholder]');
    await browser.waitUntil(async () => (await hint.getAttribute("data-placeholder")).startsWith("Describe the demand"), { timeout: 5000, timeoutMsg: "the composer kept the conversation's hint" });
    await shot("B-nova-sessao-sala");
  });

  it("opens a room's tab on the canvas of that room", async () => {
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Profile page" }),
    });
    roomId = (await created.json()).roomId;
    await browser.execute(
      (id) => {
        const tabs = [{ id, profileId: "e2e-room", title: "Profile page", room: true }];
        localStorage.setItem("anywh:tabs", JSON.stringify(tabs));
        localStorage.setItem("anywh:active-tab", id);
        localStorage.removeItem("anywh:tab-layout");
        window.location.reload();
      },
      roomId,
    );
    await $('[data-testid="sala-canvas"]').waitForExist({ timeout: 30000 });
  });

  it("draws the principal's card on it", async () => {
    await browser.waitUntil(async () => (await cards()).length === 1, { timeout: 30000, timeoutMsg: "the principal's card never appeared" });
    const principal = await $("[data-agent-id]");
    await expect(principal).toHaveText(expect.stringContaining("Main"));
    await expect(principal).toHaveText(expect.stringContaining("Profile page"));
    await shot("B-sala-so-principal");
  });

  it("shows the room as one entry with the room glyph in the sidebar and the tab strip", async () => {
    const row = await $('[role="img"][aria-label="Room"]');
    await row.waitForExist({ timeout: 15000 });
    expect((await $$('[role="img"][aria-label="Room"]')).length).toBeGreaterThanOrEqual(1);
  });

  it("draws every agent the principal delegates to, each in its state, linked to its parent", async () => {
    const open = gate();
    const workers = [
      { task: `Explore layouts for the profile\n[[gate:${open}]]`, area: "Design" },
      { task: `Review contrast and accessibility\n${roomMarker("report", { status: "done", summary: "2 contrast fixes", artifacts: [] })}`, area: "Design" },
      { task: `Map the profile features\n[[gate:${open}]]`, area: "Research" },
      { task: `Investigate the user API\n${askMarker({ tool: "Write", input: { file_path: join(stack.dir, "out.txt"), content: "x" } })}`, area: "Research" },
      { task: `Compatibility plan for iOS and Android\n[[gate:${open}]]`, area: "Code" },
    ];
    await say(
      stack.port,
      roomId,
      workers.map((w) => roomMarker("delegate", { task: w.task, runtime: "claude", model: "haiku", area: w.area })).join(" "),
    );
    await browser.waitUntil(async () => (await cards()).length === 6, { timeout: 60000, timeoutMsg: "the workers' cards never appeared" });
    await browser.waitUntil(
      async () => {
        const states = await browser.execute(() => [...document.querySelectorAll("[data-agent-id]")].map((el) => el.getAttribute("data-state")));
        return states.filter((s) => s === "working").length >= 3 && states.includes("done") && states.includes("awaiting_user");
      },
      { timeout: 60000, timeoutMsg: "the cards did not reach working/done/awaiting_user" },
    );

    // A worker delegating further: two agents under "Explore layouts", which
    // join its area.
    const members = (await (await fetch(`${stack.base}/rooms/${roomId}`)).json()).members;
    const lead = members.find((m) => m.title?.startsWith("Explore layouts"));
    await say(
      stack.port,
      roomId,
      ["Header and avatar variations", "Contrast and accessibility pass"]
        .map((task) => roomMarker("delegate", { task: `${task}\n[[gate:${open}]]`, runtime: "claude", model: "haiku", parentId: lead.id }))
        .join(" "),
    );
    await browser.waitUntil(async () => (await cards()).length === 8, { timeout: 60000, timeoutMsg: "the grandchildren never appeared" });

    // One link per worker, and the three areas the principal named.
    expect((await $$("path[data-edge]")).length).toBeGreaterThanOrEqual(7);
    expect((await $$("[data-area-id]")).length).toBe(3);
    // "Your turn" is what the waiting card says it is, with its Reply button.
    const waiting = await $('[data-agent-id][data-state="awaiting_user"]');
    await expect(waiting).toHaveText(expect.stringContaining("Your turn"));
    await expect(await waiting.$("button.sala-reply")).toBeExisting();
    // Areas never run over each other.
    const overlap = await browser.execute(() => {
      const frames = [...document.querySelectorAll("[data-area-id]")].map((el) => el.getBoundingClientRect());
      const hits = [];
      frames.forEach((a, i) =>
        frames.forEach((b, j) => {
          if (j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push([i, j]);
        }),
      );
      return hits;
    });
    expect(overlap).toEqual([]);
    await roomInView();
    await shot("B-sala-feature-grande");
  });

  it("reads at 100%: a card in full, as it is worked with", async () => {
    await browser.execute(() => document.querySelector('[aria-label$="back to 100%"]').click());
    await browser.waitUntil(async () => (await (await $('[aria-label^="Zoom "] span')).getText()) === "100%", { timeout: 15000, timeoutMsg: "the zoom never came back to 100%" });
    // Brings the card that is waiting for the person to the middle.
    await browser.execute(() => {
      const vp = document.querySelector('[data-testid="sala-canvas"]');
      const box = vp.getBoundingClientRect();
      const card = document.querySelector('[data-agent-id][data-state="awaiting_user"]').getBoundingClientRect();
      vp.dispatchEvent(new WheelEvent("wheel", { deltaX: card.left + card.width / 2 - (box.left + box.width / 2), deltaY: card.top + card.height / 2 - (box.top + box.height / 2), bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const vp = document.querySelector('[data-testid="sala-canvas"]').getBoundingClientRect();
          const card = document.querySelector('[data-agent-id][data-state="awaiting_user"]').getBoundingClientRect();
          const moving = document.querySelector(".sala-world").classList.contains("moving");
          return !moving && Math.abs(card.left + card.width / 2 - (vp.left + vp.width / 2)) < 2 && Math.abs(card.top + card.height / 2 - (vp.top + vp.height / 2)) < 2;
        }),
      { timeout: 20000, timeoutMsg: "the waiting card never came to the middle" },
    );
    await shot("B-sala-feature-grande-100");
    await browser.execute(() => document.querySelector('[aria-label="Fit to screen"]').click());
    await roomInView();
  });

  it("keeps the layout the relay was given: a card dragged lands on the grid and is saved", async () => {
    const id = await browser.execute(() => document.querySelector('[data-agent-id][data-state="done"]').getAttribute("data-agent-id"));
    const before = (await savedCanvas(stack.base, roomId)).positions[id];
    expect(before).toBeDefined();
    await drag(`[data-agent-id="${id}"] .sala-node-body`, 192, 96);
    await browser.waitUntil(
      async () => {
        const at = (await savedCanvas(stack.base, roomId)).positions[id];
        return at && (at.x !== before.x || at.y !== before.y);
      },
      { timeout: 15000, timeoutMsg: "the dragged card's position was never saved" },
    );
    const after = (await savedCanvas(stack.base, roomId)).positions[id];
    expect(after.x % 24).toBe(0);
    expect(after.y % 24).toBe(0);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  it("zooms at the cursor with Ctrl+wheel, shows it in the toolbar, and saves the camera", async () => {
    await browser.execute(() => {
      const vp = document.querySelector('[data-testid="sala-canvas"]');
      const r = vp.getBoundingClientRect();
      vp.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -200, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    });
    const label = await $('[aria-label^="Zoom "] span');
    await browser.waitUntil(async () => (await label.getText()) !== "100%" && (await label.getText()) !== "", { timeout: 5000, timeoutMsg: "the zoom label never changed" });
    await browser.waitUntil(async () => (await savedCanvas(stack.base, roomId)).camera !== undefined, { timeout: 15000, timeoutMsg: "the camera was never saved" });
    const camera = (await savedCanvas(stack.base, roomId)).camera;
    expect(camera.zoom).toBeGreaterThan(0.25);
    expect(camera.zoom).toBeLessThanOrEqual(2);
  });

  it("selects a card with a click and offers its actions", async () => {
    const worker = await $('[data-agent-id][data-state="working"] .sala-node-hit');
    await worker.click();
    const bar = await $('.sala-bar[role="toolbar"]');
    await bar.waitForExist({ timeout: 5000 });
    for (const action of ["Open conversation", "Delegate", "Group", "Stop", "Remove"]) await expect(bar).toHaveText(expect.stringContaining(action));
  });

  it("stops one agent from its action bar, and only that one", async () => {
    const id = await browser.execute(() => document.querySelector(".sala-node.sel").getAttribute("data-agent-id"));
    const stop = await $('//*[contains(@class, "sala-bar")]//button[contains(., "Stop")]');
    await stop.click();
    await browser.waitUntil(async () => (await cardState(id)) === "stopped", { timeout: 15000, timeoutMsg: "the card never showed as stopped" });
    const states = await browser.execute(() => [...document.querySelectorAll("[data-agent-id]")].map((el) => el.getAttribute("data-state")));
    expect(states.filter((s) => s === "working").length).toBeGreaterThanOrEqual(2);
  });

  it("opens ten agents on one canvas and reads them all (principal and nine workers)", async () => {
    // A room of its own, so the screen is a feature with its three fronts and
    // not what the earlier tests did to the first room.
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Profile page: ten agents" }),
    });
    roomId = (await created.json()).roomId;
    const open = gate();
    const done = (summary) => roomMarker("report", { status: "done", summary, artifacts: [] });
    const front = (area, tasks) => tasks.map((task) => roomMarker("delegate", { task, runtime: "claude", model: "haiku", area }));
    await say(
      stack.port,
      roomId,
      [
        ...front("Design", [`Explore layouts for the profile\n[[gate:${open}]]`, `Header and avatar variations\n[[gate:${open}]]`, `Review contrast and accessibility\n${done("2 contrast fixes")}`]),
        ...front("Research", [
          `Map the profile features\n[[gate:${open}]]`,
          `Benchmark of profiles in 6 apps\n${done("6 apps, benchmark ready")}`,
          `Investigate the user API\n${askMarker({ tool: "Write", input: { file_path: join(stack.dir, "api.txt"), content: "x" } })}`,
        ]),
        ...front("Code", [`Profile screen in SwiftUI\n[[gate:${open}]]`, `Profile screen in Compose\n[[gate:${open}]]`, `Shared data model\n${done("Profile v2, 11 fields")}`]),
      ].join(" "),
    );
    await browser.execute(
      (id) => {
        localStorage.setItem("anywh:tabs", JSON.stringify([{ id, profileId: "e2e-room", title: "Profile page: ten agents", room: true }]));
        localStorage.setItem("anywh:active-tab", id);
        localStorage.removeItem("anywh:tab-layout");
        window.location.reload();
      },
      roomId,
    );
    await browser.waitUntil(async () => (await cards()).length === 10, { timeout: 60000, timeoutMsg: "ten cards never appeared" });
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-state="awaiting_user"]') && !!document.querySelector('[data-state="done"]') && !!document.querySelector('[data-state="working"]')),
      { timeout: 60000, timeoutMsg: "the ten cards did not reach working, done and awaiting_user" },
    );
    expect((await $$("[data-area-id]")).length).toBe(3);
    await browser.execute(() => {
      // "Fit to screen"
      document.querySelector('[aria-label="Fit to screen"]').click();
    });
    // Nothing selected, so the shot shows the room and not an action bar.
    await browser.execute(() => document.querySelector('[data-testid="sala-canvas"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await roomInView();
    await shot("B-sala-10-agentes");
    // What the canvas itself costs a frame while panning, in the real
    // engine with every card live: the time the camera's write takes on the
    // main thread, not the compositor's (Xvfb has no GPU, so a frame's wall
    // time there is software rasterization and says nothing about the code:
    // a lone 200px div moved by `transform` runs at ~15 fps in the same
    // window). The assertion guards against the camera write growing a cost
    // per card; the frame rate is printed for the record.
    const cost = await browser.executeAsync((done) => {
      const vp = document.querySelector('[data-testid="sala-canvas"]');
      const wheel = () => vp.dispatchEvent(new WheelEvent("wheel", { deltaX: 3, deltaY: 2, bubbles: true, cancelable: true }));
      for (let i = 0; i < 20; i += 1) wheel();
      const t0 = performance.now();
      for (let i = 0; i < 200; i += 1) wheel();
      const perWrite = (performance.now() - t0) / 200;
      let frames = 0;
      const f0 = performance.now();
      const tick = (now) => {
        frames += 1;
        wheel();
        if (now - f0 < 1500) requestAnimationFrame(tick);
        else done({ perWrite, fps: frames / ((now - f0) / 1000) });
      };
      requestAnimationFrame(tick);
    });
    console.log(`[sala perf] 10 agents: camera write ${cost.perWrite.toFixed(3)} ms, wheel-pan ${cost.fps.toFixed(1)} fps (software rendering)`);
    expect(cost.perWrite).toBeLessThan(3);
  });

  it("finds the saved layout again after the app reloads", async () => {
    // The camera is written back a moment after it settles: wait until the
    // relay has the zoom the toolbar shows.
    await browser.waitUntil(
      async () => {
        const shown = Number.parseInt(await (await $('[aria-label^="Zoom "] span')).getText(), 10);
        const camera = (await savedCanvas(stack.base, roomId)).camera;
        return camera !== undefined && Math.round(camera.zoom * 100) === shown;
      },
      { timeout: 15000, timeoutMsg: "the relay never got the camera the screen shows" },
    );
    const saved = await savedCanvas(stack.base, roomId);
    const ids = Object.keys(saved.positions);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    await browser.execute(() => window.location.reload());
    await browser.waitUntil(async () => (await cards()).length === 10, { timeout: 30000, timeoutMsg: "the room did not come back with its ten cards" });
    // Every card is exactly where the relay says it is: the world is at the
    // saved camera, so a card's screen position follows from both.
    const placed = await browser.execute(() => {
      const vp = document.querySelector('[data-testid="sala-canvas"]').getBoundingClientRect();
      return [...document.querySelectorAll("[data-agent-id]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute("data-agent-id"), left: r.left - vp.left, top: r.top - vp.top, width: r.width };
      });
    });
    const { camera } = await savedCanvas(stack.base, roomId);
    for (const card of placed) {
      const at = saved.positions[card.id];
      expect(Math.abs(card.left - (at.x * camera.zoom + camera.x))).toBeLessThan(1.5);
      expect(Math.abs(card.top - (at.y * camera.zoom + camera.y))).toBeLessThan(1.5);
    }
  });

  it("reflects the room in the sidebar, its tab and the status bar", async () => {
    await browser.execute(() => document.querySelector('[data-testid="sala-canvas"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // The room waits for the person (one agent asked), so it sits under "Needs you" with the count.
    await browser.waitUntil(async () => (await $("body").getText()).includes("Needs you"), { timeout: 30000, timeoutMsg: "the sidebar never grouped the room under Needs you" });
    // The tab carries the state dot and the status bar sums the room's agents.
    const status = await browser.execute(() => document.body.innerText);
    expect(status).toMatch(/\d+ running/);
    expect(status).toMatch(/\d+ need you/);
    await expect(await $('[role="tab"] [aria-label$="need you"]')).toBeExisting();
    await shot("B-sala-feature-grande-shell");
  });

  it("opens 'About this room' with the room's numbers, usage and worktrees, and closes it with Esc", async () => {
    await press('button[aria-label="About this room"]');
    const panel = await $('aside[data-panel="about"]');
    await panel.waitForExist({ timeout: 15000 });
    const text = await panel.getText();
    expect(text).toContain("Where it runs");
    expect(text).toContain("Areas");
    expect(text).toContain("Usage");
    expect(text).toContain("Shared context");
    expect(text).toContain("Worktrees");
    // The "i" button gives way to the panel.
    expect(await $$('button[aria-label="About this room"]').length).toBe(0);
    await browser.waitUntil(async () => (await panel.getText()).includes("10"), { timeout: 15000, timeoutMsg: "the agent count never showed" });
    await panelSettled();
    await shot("B-sobre-a-sala");
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await $('aside[data-panel="about"]').isExisting()), { timeout: 5000, timeoutMsg: "Esc did not close the panel" });
  });

  it("answers in the card: Reply opens the question under it, with a way into the whole conversation", async () => {
    await press('[data-agent-id][data-state="awaiting_user"] button.sala-reply');
    const popover = await $(".sala-answer");
    await popover.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await popover.getText()).includes("Approve"), { timeout: 15000, timeoutMsg: "the question never reached the card" });
    await expect(popover).toHaveText(expect.stringContaining("Open conversation"));
    await shot("B-pergunta-no-card");
  });

  it("opens the agent's summary: state, who delegated it, the question, work and the message box", async () => {
    await press(".sala-answer-foot button");
    const panel = await $('aside[data-panel="agent"]');
    await panel.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await panel.getText()).includes("Approve"), { timeout: 15000, timeoutMsg: "the question never reached the panel" });
    const text = await panel.getText();
    expect(text).toContain("Your turn");
    expect(text).toContain("Delegated by");
    expect(text).toContain("Work");
    await expect(await panel.$("textarea")).toBeExisting();
    for (const action of ["Open in tab", "Delegate", "Stop", "Remove"]) expect(text).toContain(action);
    await panelSettled();
    await shot("B-resumo-do-agente");
    await press('aside[data-panel="agent"] button[aria-label="Close panel"]');
    await browser.waitUntil(async () => !(await $('aside[data-panel="agent"]').isExisting()), { timeout: 5000 });
  });

  it("speaks Portuguese when the app does: the card states, the area counts and the toolbar", async () => {
    await browser.execute(() => {
      localStorage.setItem("anywh:locale", "pt-BR");
      window.location.reload();
    });
    await browser.waitUntil(async () => (await cards()).length === 10, { timeout: 30000, timeoutMsg: "the room did not come back" });
    const text = await browser.execute(() => document.querySelector('[data-testid="sala-canvas"]').innerText);
    expect(text).toContain("Principal");
    expect(text).toContain("Sua vez");
    expect(text).toContain("Responder");
    expect(text).toMatch(/espera você/);
    await expect(await $('[aria-label="Ajustar à tela"]')).toBeExisting();
    await browser.execute(() => document.querySelector('[aria-label="Ajustar à tela"]').click());
    await roomInView();
    await shot("B-sala-10-agentes-pt");
    await press('button[aria-label="Sobre a sala"]');
    const aboutPt = await $('aside[data-panel="about"]');
    await aboutPt.waitForExist({ timeout: 15000 });
    const aboutText = await aboutPt.getText();
    expect(aboutText).toContain("Onde roda");
    expect(aboutText).toContain("Contexto compartilhado");
    await panelSettled();
    await shot("B-sobre-a-sala-pt");
    await press('aside[data-panel="about"] button[aria-label="Fechar painel"]');
    await $('[aria-label="Nova sessão"]').click();
    const group = await $('[role="radiogroup"][aria-label="Tipo de sessão"]');
    await group.waitForExist({ timeout: 15000 });
    await group.$('//*[@role="radio"][contains(., "Sala")]').click();
    await browser.waitUntil(async () => (await (await group.$('[role="radio"][aria-checked="true"]')).getText()).includes("Sala"), { timeout: 5000 });
    await shot("B-nova-sessao-sala-pt");
  });

  it("shows a small task too: the principal and two agents, one waiting for the person", async () => {
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Fix the spinner stuck on the phone" }),
    });
    const small = (await created.json()).roomId;
    smallRoom = small;
    await say(
      stack.port,
      small,
      [
        roomMarker("delegate", { task: `Stop the spinner in MessageLog\n[[gate:${gate()}]]`, runtime: "claude", model: "haiku" }),
        roomMarker("delegate", { task: `Review the retry in useSession\n${askMarker({ tool: "Write", input: { file_path: join(stack.dir, "retry.txt"), content: "x" } })}`, runtime: "claude", model: "haiku" }),
      ].join(" "),
    );
    await browser.execute(
      (id) => {
        // The Portuguese test is over: the rest of the file reads English.
        localStorage.removeItem("anywh:locale");
        localStorage.setItem("anywh:tabs", JSON.stringify([{ id, profileId: "e2e-room", title: "Fix the spinner stuck on the phone", room: true }]));
        localStorage.setItem("anywh:active-tab", id);
        localStorage.removeItem("anywh:tab-layout");
        window.location.reload();
      },
      small,
    );
    await browser.waitUntil(async () => (await cards()).length === 3, { timeout: 60000, timeoutMsg: "the small room's three cards never appeared" });
    await browser.waitUntil(async () => (await browser.execute(() => !!document.querySelector('[data-state="awaiting_user"]'))), { timeout: 60000 });
    await roomInView();
    await shot("B-sala-tarefa-pequena");
  });

  it("answers a question from the card: the agent goes on", async () => {
    // The small room's second agent is waiting for approval.
    await press('[data-agent-id][data-state="awaiting_user"] button.sala-reply');
    const popover = await $(".sala-answer");
    await popover.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await popover.getText()).includes("Approve"), { timeout: 15000, timeoutMsg: "the question never reached the card" });
    const id = await browser.execute(() => document.querySelector('[data-agent-id][data-state="awaiting_user"]').getAttribute("data-agent-id"));
    await popover.$("button*=Approve").click();
    await popover.$('button[aria-label="Send answers"]').click();
    await browser.waitUntil(async () => (await cardState(id)) !== "awaiting_user", { timeout: 30000, timeoutMsg: "the agent never went on after the answer" });
    await browser.waitUntil(async () => !(await $(".sala-answer").isExisting()), { timeout: 5000 });
  });

  it("shows the principal's whole conversation in the side panel", async () => {
    await press('[data-agent-id].main .sala-node-hit');
    await pressBar("Open conversation");
    const panel = await $('aside[data-panel="principal"]');
    await panel.waitForExist({ timeout: 15000 });
    // The same chat a session tab shows: its history and its composer.
    await panel.$(".composer-editor").waitForExist({ timeout: 30000, timeoutMsg: "the principal's composer never appeared" });
    await browser.waitUntil(async () => (await panel.getText()).includes("[[room:delegate"), { timeout: 30000, timeoutMsg: "the principal's history never showed what was said to it" });
    await panelSettled();
    await shot("B-conversa-do-principal");
    await press('aside[data-panel="principal"] button[aria-label="Close panel"]');
  });

  it("starts an agent by hand from the launcher, delegated by the principal", async () => {
    await press('button[aria-label="New agent"]');
    const box = await $(".sala-launcher textarea");
    await box.waitForExist({ timeout: 15000 });
    await expect(await $(".sala-launcher")).toHaveText(expect.stringContaining("Delegated by"));
    await shot("B-novo-agente");
    const before = (await cards()).length;
    await box.setValue(`Write the release notes ${roomMarker("report", { status: "done", summary: "notes", artifacts: [] })}`);
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await cards()).length === before + 1, { timeout: 60000, timeoutMsg: "the new agent's card never appeared" });
    await browser.waitUntil(async () => !(await $(".sala-launcher").isExisting()), { timeout: 5000, timeoutMsg: "the launcher stayed open" });
    const members = (await (await fetch(`${stack.base}/rooms/${smallRoom}`)).json()).members;
    const made = members.find((m) => m.title?.startsWith("Write the release notes"));
    expect(made.room.createdBy).toBe("user");
  });

  it("shows an agent that failed, in the same language as the rest", async () => {
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Migrate the cache" }),
    });
    const failing = (await created.json()).roomId;
    await say(
      stack.port,
      failing,
      [
        roomMarker("delegate", { task: "Migrate the cache\n[[crash]]", runtime: "claude", model: "haiku" }),
        roomMarker("delegate", { task: `Write the notes\n${roomMarker("report", { status: "done", summary: "notes written", artifacts: [] })}`, runtime: "claude", model: "haiku" }),
      ].join(" "),
    );
    await openRoomTab(failing, "Migrate the cache");
    await browser.waitUntil(async () => (await cards()).length === 3, { timeout: 60000, timeoutMsg: "the three cards never appeared" });
    await browser.waitUntil(async () => (await browser.execute(() => !!document.querySelector('[data-state="failed"]'))), { timeout: 60000, timeoutMsg: "no card ever failed" });
    await roomInView();
    await shot("B-sala-agente-falhou");
    await press('[data-state="failed"] .sala-node-hit');
    await pressBar("Open conversation");
    const panel = await $('aside[data-panel="agent"]');
    await panel.waitForExist({ timeout: 15000 });
    const text = await panel.getText();
    expect(text).toContain("Failed");
    expect(text).toContain("This agent failed");
    await panelSettled();
    await shot("B-agente-falhou");
  });

  it("completes a room whose agents are all done, keeps the work nobody integrated, and asks before discarding it", async () => {
    const repo = join(stack.dir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args) => execFileSync("git", ["-c", "user.email=e2e@anywh.test", "-c", "user.name=e2e", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: repo, title: "Polish the profile" }),
    });
    const finished = (await created.json()).roomId;
    const done = (summary) => roomMarker("report", { status: "done", summary, artifacts: [] });
    await say(
      stack.port,
      finished,
      [
        roomMarker("delegate", { task: `Review the copy\n${done("copy reviewed")}`, runtime: "claude", model: "haiku" }),
        roomMarker("delegate", { task: `Spike the avatar crop\n${roomMarker("worktree_create", { repo })}${done("spike done")}`, runtime: "claude", model: "haiku" }),
      ].join(" "),
    );
    // The spike's worktree gets a commit nobody integrates.
    let worktree;
    await browser.waitUntil(
      async () => {
        const { worktrees } = await (await fetch(`${stack.base}/rooms/${finished}/worktrees`)).json();
        worktree = worktrees[0];
        return worktree !== undefined;
      },
      { timeout: 60000, timeoutMsg: "the spike never made a worktree" },
    );
    execFileSync("git", ["-c", "user.email=e2e@anywh.test", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "crop"], { cwd: worktree.path, stdio: "pipe" });
    await openRoomTab(finished, "Polish the profile");
    await browser.waitUntil(async () => (await cards()).length === 3, { timeout: 60000 });
    const strip = await $(".sala-done");
    await strip.waitForExist({ timeout: 60000, timeoutMsg: "the room never showed as completed" });
    await browser.waitUntil(async () => (await strip.getText()).includes("1 worktree kept"), { timeout: 30000, timeoutMsg: "the kept worktree was never counted" });
    await roomInView();
    await shot("B-sala-concluida");
    await press(".sala-done button");
    const panel = await $('aside[data-panel="about"]');
    await panel.waitForExist({ timeout: 15000 });
    await browser.waitUntil(async () => (await panel.getText()).includes("anywh/"), { timeout: 15000, timeoutMsg: "the worktree never showed" });
    expect(await panel.getText()).toContain("1 worktree kept with work that was not integrated");
    await panelSettled();
    await shot("B-sala-concluida-sobre");
    await press('aside[data-panel="about"] button[aria-label="Close panel"]');

    // Removing the agent that made it asks first: the work would be lost.
    const spike = await browser.execute(() => [...document.querySelectorAll("[data-agent-id]")].find((el) => el.textContent.includes("Spike the avatar crop")).getAttribute("data-agent-id"));
    await press(`[data-agent-id="${spike}"] .sala-node-hit`);
    await pressBar("Remove");
    const dialog = await $('[role="alertdialog"]');
    await dialog.waitForExist({ timeout: 15000, timeoutMsg: "the relay's refusal never became a question" });
    expect(await dialog.getText()).toContain("not integrated");
    await shot("B-descartar-trabalho");
    await dialog.$("button*=Discard and remove").click();
    await browser.waitUntil(async () => (await cards()).length === 2, { timeout: 30000, timeoutMsg: "the agent was never removed" });
    await browser.waitUntil(async () => (await (await fetch(`${stack.base}/rooms/${finished}/worktrees`)).json()).worktrees.length === 0, { timeout: 45000, timeoutMsg: "the worktree was never discarded after the undo window" });
  });
});
