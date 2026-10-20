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

const cards = () => $$("[data-agent-id]");
const cardState = (id) => browser.execute((agent) => document.querySelector(`[data-agent-id="${agent}"]`)?.getAttribute("data-state"), id);
const savedCanvas = async (base, roomId) => (await (await fetch(`${base}/rooms/${roomId}/canvas`)).json()).canvas;

describe("anywh room canvas", () => {
  let stack;
  let roomId;
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
      }, previous);
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
    await shot("A-nova-sessao-conversa");
    await group.$('//*[@role="radio"][contains(., "Room")]').click();
    await browser.waitUntil(async () => (await (await group.$('[role="radio"][aria-checked="true"]')).getText()).includes("Room"), { timeout: 5000 });
    const hint = await $('.composer-editor p.is-editor-empty[data-placeholder]');
    await browser.waitUntil(async () => (await hint.getAttribute("data-placeholder")).startsWith("Describe the demand"), { timeout: 5000, timeoutMsg: "the composer kept the conversation's hint" });
    await shot("A-nova-sessao-sala");
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
    await shot("A-sala-so-principal");
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
    await shot("A-sala-feature-grande");
  });

  it("reads at 100%: a card in full, as it is worked with", async () => {
    await browser.execute(() => document.querySelector('[aria-label$="back to 100%"]').click());
    await browser.waitUntil(async () => (await (await $('[aria-label^="Zoom "] span')).getText()) === "100%", { timeout: 5000 });
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
    await shot("A-sala-feature-grande-100");
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
    for (const action of ["Group", "Stop", "Remove"]) await expect(bar).toHaveText(expect.stringContaining(action));
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
    await shot("A-sala-10-agentes");
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
    await shot("A-sala-10-agentes-pt");
    await $('[aria-label="Nova sessão"]').click();
    const group = await $('[role="radiogroup"][aria-label="Tipo de sessão"]');
    await group.waitForExist({ timeout: 15000 });
    await group.$('//*[@role="radio"][contains(., "Sala")]').click();
    await browser.waitUntil(async () => (await (await group.$('[role="radio"][aria-checked="true"]')).getText()).includes("Sala"), { timeout: 5000 });
    await shot("A-nova-sessao-sala-pt");
  });

  it("shows a small task too: the principal and two agents, one waiting for the person", async () => {
    const created = await fetch(`${stack.base}/rooms`, {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", model: "haiku", permissionMode: "default", cwd: stack.dir, title: "Fix the spinner stuck on the phone" }),
    });
    const small = (await created.json()).roomId;
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
    await shot("A-sala-tarefa-pequena");
  });
});
