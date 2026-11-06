import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The dock's entry points in the real Tauri window. The panes themselves
// can't be exercised here: both toggles are gated on the session having a
// folder, and a folder only exists once a relay has answered — no relay runs
// in this tier. So what is provable is the structure and the gate, which are
// real behaviour and not a harness artifact: the panel's rail is there with
// the panel closed, toggle and pane buttons both; opening and hiding the
// panel leaves the rail as it is; and the pane buttons are deliberately inert
// until there is something to list.
//
// Opening a pane for real (its header, maximize, the split divider) needs a
// relay and belongs to whichever tier grows one. The toggles are plain
// `<button onClick>`, not Radix triggers, so a driver click does reach them
// (unlike the dropdown triggers in shell.spec.js) — the gate is what stops
// them, nothing else.
// Screenshots go to `ANYWH_E2E_SCREENSHOTS` when it is set (a folder outside
// the repo); otherwise none are taken.
const SHOTS = process.env.ANYWH_E2E_SCREENSHOTS;

describe("anywh dock panels", () => {
  before(async () => {
    const newConversation = await $('[aria-label="New session"]');
    await newConversation.waitForExist({ timeout: 15000 });
    await newConversation.click();
  });

  it("has the side panel's toggle and the pane buttons in its rail while it is closed", async () => {
    const panelToggle = await $('[data-testid="dock-rail"] [aria-label="Show side panel"]');
    await panelToggle.waitForExist({ timeout: 15000 });
    for (const label of ["Open files", "Open terminal"]) {
      await expect(await $(`[data-testid="dock-rail"] [aria-label="${label}"]`).isExisting()).toBe(true);
    }
    await expect(await $('[data-testid="dock-empty-state"]').isDisplayed()).toBe(false);
    await expect(await $('[aria-label="Close panel"]').isExisting()).toBe(false);
  });

  it("opens the panel on its empty state, with both pane buttons inert until the session has a folder", async () => {
    const panelToggle = await $('[aria-label="Show side panel"]');
    await panelToggle.click();

    // A tab that never had a pane opens nothing selected, so both read "open".
    await $('[data-testid="dock-empty-state"]').waitForExist({ timeout: 15000 });
    for (const label of ["Open files", "Open terminal"]) {
      const toggle = await $(`[aria-label="${label}"]`);
      await toggle.waitForExist({ timeout: 15000 });
      await expect(await toggle.isEnabled()).toBe(false);
    }
    await expect(await $('[aria-label="Hide side panel"]').isExisting()).toBe(true);
    if (SHOTS) {
      // The column opens by animating its width; wait until it has.
      await browser.waitUntil(() => browser.execute(() => (document.querySelector('[data-testid="dock-empty-state"]')?.getBoundingClientRect().width ?? 0) >= 300), { timeout: 10000, timeoutMsg: "the side panel never finished opening" });
      mkdirSync(SHOTS, { recursive: true });
      await browser.saveScreenshot(join(SHOTS, "right-sidebar-empty-state.png"));
    }
  });

  it("keeps the pane buttons in the rail when the panel is hidden", async () => {
    const panelToggle = await $('[aria-label="Hide side panel"]');
    await panelToggle.click();

    await $('[aria-label="Show side panel"]').waitForExist({ timeout: 15000 });
    for (const label of ["Open files", "Open terminal"]) {
      await expect(await $(`[data-testid="dock-rail"] [aria-label="${label}"]`).isExisting()).toBe(true);
    }
  });
});
