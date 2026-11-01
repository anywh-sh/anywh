// The dock's entry points in the real Tauri window. The panes themselves
// can't be exercised here: both toggles are gated on the session having a
// folder, and a folder only exists once a relay has answered — no relay runs
// in this tier. So what is provable is the structure and the gate, which are
// real behaviour and not a harness artifact: a tab with nothing open has no
// side panel and none of its buttons; opening the panel brings the buttons,
// and they are deliberately inert until there is something to list.
//
// Opening a pane for real (its header, maximize, the split divider) needs a
// relay and belongs to whichever tier grows one. The toggles are plain
// `<button onClick>`, not Radix triggers, so a driver click does reach them
// (unlike the dropdown triggers in shell.spec.js) — the gate is what stops
// them, nothing else.
describe("anywh dock panels", () => {
  before(async () => {
    const newConversation = await $('[aria-label="New session"]');
    await newConversation.waitForExist({ timeout: 15000 });
    await newConversation.click();
  });

  it("has the side panel's toggle, and none of the pane buttons, while it is closed", async () => {
    const panelToggle = await $('[aria-label="Show side panel"]');
    await panelToggle.waitForExist({ timeout: 15000 });
    for (const label of ["Open files", "Close files", "Open terminal", "Close terminal"]) {
      await expect(await $(`[aria-label="${label}"]`).isExisting()).toBe(false);
    }
    await expect(await $('[aria-label="Close panel"]').isExisting()).toBe(false);
  });

  it("opens the panel on Files, with both pane buttons inert until the session has a folder", async () => {
    const panelToggle = await $('[aria-label="Show side panel"]');
    await panelToggle.click();

    // A tab that never had a pane opens Files, so that button reads "close".
    for (const label of ["Close files", "Open terminal"]) {
      const toggle = await $(`[aria-label="${label}"]`);
      await toggle.waitForExist({ timeout: 15000 });
      await expect(await toggle.isEnabled()).toBe(false);
    }
    await expect(await $('[aria-label="Hide side panel"]').isExisting()).toBe(true);
  });

  it("takes the pane buttons away again when the panel is hidden", async () => {
    const panelToggle = await $('[aria-label="Hide side panel"]');
    await panelToggle.click();

    await $('[aria-label="Show side panel"]').waitForExist({ timeout: 15000 });
    for (const label of ["Close files", "Open terminal"]) {
      await expect(await $(`[aria-label="${label}"]`).isExisting()).toBe(false);
    }
  });
});
