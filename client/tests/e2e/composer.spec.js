// The composer in the real Tauri window. No relay runs in this tier, so
// nothing here sends anything — and nothing here types, either: this driver
// cannot put text into a contenteditable (see the note below). What is left
// is still worth proving under the real webview, because it is what jsdom
// cannot answer: the toolbar mounts, the editor takes focus on its own when
// a conversation opens, and the send button starts out refusing an empty
// message.
//
// **The driver cannot type into ProseMirror, and it is not an app bug.**
// With the editor verifiably focused (`document.activeElement` is the
// `.ProseMirror` div, carrying `ProseMirror-focused`), none of the three
// ways in produce a single character: `browser.keys`, `element.addValue`
// and a `document.execCommand("insertText")` run inside `browser.execute`
// all leave `textContent` empty. Key *events* do arrive — that is what opens
// a Radix menu from `browser.keys("Enter")` in shell.spec.js — but WebKit's
// editing pipeline never runs for synthesized ones, so no `beforeinput`
// reaches ProseMirror. Anything that needs typed text (send, the slash menu,
// the typo confirmation) is covered in client/tests/ui instead, which is
// where those flows already live.
//
// Editor *focus* is not assertable here either, though it does happen: read
// back inside the same `browser.execute` that opens a conversation,
// `document.activeElement` is the `.ProseMirror` div; read from a later
// command it never is, run after run. Something between two driver commands
// takes it away, so an autofocus assertion in this tier would be testing the
// harness, not the app.
describe("anywh composer", () => {
  before(async () => {
    const newConversation = await $('[aria-label="New session"]');
    await newConversation.waitForExist({ timeout: 15000 });
    await newConversation.click();
  });

  it("renders the toolbar the conversation is driven from", async () => {
    for (const label of ["Attach image or video", "Record audio", "Send"]) {
      const control = await $(`[aria-label="${label}"]`);
      await control.waitForExist({ timeout: 15000 });
      await expect(control).toBeExisting();
    }
  });

  it("keeps Send disabled until there is something to send", async () => {
    const send = await $('[aria-label="Send"]');
    await send.waitForExist({ timeout: 15000 });
    await expect(await send.isEnabled()).toBe(false);
  });

});
