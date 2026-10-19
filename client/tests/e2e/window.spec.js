// Smoke test for this tier: the real Tauri app (real window, real webview)
// boots and its shell renders — no relay running, so this only proves the
// app itself launches under WebdriverIO's embedded provider, not any
// relay-dependent flow (those need the client/tests/ui fake-relay tier, or a
// real relay for a fuller e2e scenario later).
describe("anywh desktop shell", () => {
  it("launches the main window and renders the sidebar", async () => {
    const newConversationButton = await $('[aria-label="New session"]');
    await newConversationButton.waitForExist({ timeout: 15000 });
    await expect(newConversationButton).toBeExisting();
  });
});
