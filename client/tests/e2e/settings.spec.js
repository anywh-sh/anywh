// The redesigned settings dialog in the real Tauri window: its rail, the two
// kinds of page it can show, and the fact that it closes. All of it is
// client-only state — the profile list is the one profile wdio.conf.js seeds
// (labelled "Default") and the theme catalog falls back to the two built-in
// themes when no relay answers, which is exactly the case in this tier.
//
// What this is actually here to catch is the portal/focus-trap class of
// WebKitGTK/WKWebView breakage: the dialog portals into `document.body`, and
// it is opened from a Radix dropdown that portals there too, which is the
// combination that already broke this app once.
describe("anywh settings", () => {
  async function openSettings() {
    const menu = await $('[aria-label="Menu"]');
    await menu.waitForExist({ timeout: 15000 });
    // Keyboard, not a click: a WebDriver click never delivers the
    // `pointerdown` a Radix trigger opens on (see shell.spec.js for the full
    // finding). Enter opens the menu, and the first item in it is Settings.
    await menu.click();
    await browser.keys("Enter");

    const settings = await $('[role="menuitem"]');
    await settings.waitForExist({ timeout: 5000 });
    await browser.keys("Enter");

    const dialog = await $('[role="dialog"]');
    await dialog.waitForExist({ timeout: 5000 });
    return dialog;
  }

  it("opens from the title bar menu, landing on the active profile's page", async () => {
    await openSettings();

    // The rail lists the profile; the page shows its name as the heading and
    // the settings that belong to it.
    const heading = await $('//h2[contains(text(), "Default")]');
    await heading.waitForExist({ timeout: 5000 });
    await expect(heading).toBeExisting();

    const starting = await $('//*[contains(text(), "Starting folder")]');
    await expect(starting).toBeExisting();
  });

  it("switches to the app page, which offers the built-in themes", async () => {
    // `contains(., …)` rather than `contains(text(), …)`: the label is in a
    // nested span, and `text()` only matches a node's own direct text — the
    // form the other specs use works there because their labels are direct
    // text. A plain `<button onClick>`, unlike the dropdown triggers above,
    // so a driver click does reach it.
    const appearance = await $('//button[contains(., "Appearance")]');
    await appearance.waitForExist({ timeout: 5000 });
    await appearance.click();

    for (const theme of ["Noite", "Papel"]) {
      const card = await $(`//*[contains(text(), "${theme}")]`);
      await card.waitForExist({ timeout: 5000 });
      await expect(card).toBeExisting();
    }

    // The device-wide text size lives here too, not on a profile page.
    const fontSize = await $('//*[contains(text(), "Text size")]');
    await expect(fontSize).toBeExisting();
  });

  it("closes on Escape", async () => {
    await browser.keys("Escape");
    await browser.waitUntil(async () => !(await $('[role="dialog"]').isExisting()), {
      timeout: 5000,
      timeoutMsg: "settings dialog stayed open after Escape",
    });
  });
});
