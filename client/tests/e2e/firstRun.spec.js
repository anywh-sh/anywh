// The first-run screen in the real Tauri window. No relay and no profile:
// the gate in App.tsx has to put the first run on the window instead of the
// shell, with its own window bar (the shell's TitleBar isn't there) and the
// language picker reachable. The recognition step runs the real probe
// against this machine's disk, so which screen comes after it depends on
// the runner — the window caption and the picker are what every outcome
// shares, and what this asserts.
//
// The driver can't type, so this can't walk a path (client/tests/ui does);
// it proves the screen exists under the real webview, which is where the
// portal/focus-trap class of WebKitGTK breakage shows up.
describe("anywh first run", () => {
  const seeded = JSON.stringify([{ id: "e2e", label: "Default", host: "127.0.0.1", relayPort: 8765 }]);

  it("takes over the window when the device has no profile", async () => {
    await browser.execute(() => {
      localStorage.setItem("anywh:profiles", "[]");
      window.location.reload();
    });

    const caption = await $('//*[contains(text(), "anywh.sh — onboarding")]');
    await caption.waitForExist({ timeout: 15000 });
    await expect(caption).toBeExisting();
    await expect(await $('[aria-label="New conversation"]')).not.toBeExisting();

    const language = await $('//button[normalize-space()="en"]');
    await language.waitForExist({ timeout: 5000 });
    await expect(language).toBeExisting();
  });

  // Puts the shell back for whatever runs next against this app-data dir
  // (wdio.conf.js's `before` would reseed an empty list anyway; this keeps a
  // developer's own run from ending on the first run).
  after(async () => {
    await browser.execute((profiles) => {
      localStorage.setItem("anywh:profiles", profiles);
      window.location.reload();
    }, seeded);
    await $('[aria-label="New conversation"]').waitForExist({ timeout: 15000 });
  });
});
