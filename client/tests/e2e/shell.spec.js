// The redesigned shell, in the real Tauri window. No relay is running for
// this tier, so nothing here depends on a session list arriving — what it
// proves is that the window frame and the sidebar chrome actually render and
// respond under the real webview, which is the only place WKWebView/WebKitGTK
// specific breakage (portals, focus traps, dropdown positioning) ever shows
// up. See client/tests/ui for the flows that need a relay.
describe("anywh desktop shell", () => {
  it("renders the title bar controls", async () => {
    for (const label of ["Menu", "Collapse sidebar"]) {
      const control = await $(`[aria-label="${label}"]`);
      await control.waitForExist({ timeout: 15000 });
      await expect(control).toBeExisting();
    }

    // The history buttons were removed from the redesigned bar.
    for (const label of ["Back", "Forward"]) {
      await expect(await $(`[aria-label="${label}"]`)).not.toBeExisting();
    }
  });

  it("opens the app menu from the title bar", async () => {
    const menu = await $('[aria-label="Menu"]');
    await menu.waitForExist({ timeout: 15000 });

    // Opened with the keyboard, not with a click, and not by choice: a
    // WebDriver click in this webview delivers only an untrusted `click`
    // plus a real `focus` — no `pointerdown`, no `mousedown` (verified by
    // recording native listeners during a driver click; the webview itself
    // does support PointerEvent). Radix's DropdownMenuTrigger opens on
    // `pointerdown`, so `.click()` can never open it here, and the W3C
    // Actions API does not help either. What used to look like a broken
    // menu was the trigger's tooltip opening on that focus event instead.
    // Enter goes through the trigger's keydown path, which the driver does
    // deliver, and still exercises the part this tier is here for: the
    // portal into `document.body` and its focus trap, which already broke
    // under WKWebView once (see CLAUDE.md). Any future click-driven test of
    // a Radix trigger in this tier will hit the same wall.
    await menu.click();
    await browser.keys("Enter");

    const settings = await $('[role="menuitem"]');
    await settings.waitForExist({ timeout: 5000 });
    await expect(settings).toHaveText(expect.stringContaining("Settings"));

    await browser.keys("Escape");
  });

  it("renders the sidebar with the profile switcher, search and the new-session row", async () => {
    for (const label of ["Active profile", "Search", "New session"]) {
      const control = await $(`[aria-label="${label}"]`);
      await control.waitForExist({ timeout: 15000 });
      await expect(control).toBeExisting();
    }
  });

  it("collapses and restores the sidebar", async () => {
    const collapse = await $('[aria-label="Collapse sidebar"]');
    await collapse.waitForExist({ timeout: 15000 });
    await collapse.click();

    // Collapsing unmounts the sidebar entirely rather than animating its
    // width — the design asked for a width transition and it was turned down
    // on purpose, this being one of the two most frequent interactions in
    // the app.
    const expand = await $('[aria-label="Expand sidebar"]');
    await expand.waitForExist({ timeout: 5000 });
    await expect(await $('[aria-label="New session"]')).not.toBeExisting();

    await expand.click();
    const restored = await $('[aria-label="New session"]');
    await restored.waitForExist({ timeout: 5000 });
    await expect(restored).toBeExisting();
  });
});
