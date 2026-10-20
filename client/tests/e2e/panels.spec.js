// The dock's entry points in the real Tauri window. The panes themselves
// can't be opened here: both toggles are gated on the session having a
// folder, and a folder only exists once a relay has answered — no relay runs
// in this tier. So what is provable is the gate itself, which is real
// behaviour and not a harness artifact: the controls are present and
// deliberately inert until there is something to list.
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

  it("renders both pane toggles in the conversation's toolbar", async () => {
    for (const label of ["Open files", "Open terminal"]) {
      const toggle = await $(`[aria-label="${label}"]`);
      await toggle.waitForExist({ timeout: 15000 });
      await expect(toggle).toBeExisting();
    }
  });

  it("keeps them inert until the session has a folder to show", async () => {
    for (const label of ["Open files", "Open terminal"]) {
      const toggle = await $(`[aria-label="${label}"]`);
      await expect(await toggle.isEnabled()).toBe(false);
    }
  });

  it("leaves the dock closed while they are", async () => {
    // The dock column exists at zero width even when shut, so the pane's own
    // header is what says whether anything actually opened.
    await expect(await $('[aria-label="Close panel"]').isExisting()).toBe(false);
  });
});
