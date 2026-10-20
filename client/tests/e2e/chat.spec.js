// The conversation surface in the real Tauri window. No relay runs in this
// tier, so nothing here waits on a session: what a tab needs to exist is
// client state alone (`useTabs`), which is exactly the part of the redesign
// worth proving under the real webview — the strip scrolls horizontally,
// carries a drag context and portals its tooltips and context menus, and
// those are the things that only break outside jsdom.
describe("anywh conversation tabs", () => {
  // Tabs are persisted in `localStorage`, so a re-run against an app data
  // dir that already has some would break any assertion written against an
  // absolute count. Everything below counts from whatever was already open.
  let baseline = 0;

  it("opens a conversation and names its tab from the dictionary", async () => {
    baseline = (await $$('[role="tab"]')).length;

    const newConversation = await $('[aria-label="New session"]');
    await newConversation.waitForExist({ timeout: 15000 });
    await newConversation.click();

    const tab = await $('[role="tab"]');
    await tab.waitForExist({ timeout: 5000 });
    // The relay is what titles a session, and there is none here — so this
    // is the untitled fallback, which is the one string every surface that
    // names a session shares.
    await expect(tab).toHaveText(expect.stringContaining("New session"));
  });

  it("opens a second conversation from the + at the end of the strip", async () => {
    const newTab = await $('[aria-label="New tab"]');
    await newTab.waitForExist({ timeout: 15000 });
    await newTab.click();

    await browser.waitUntil(async () => (await $$('[role="tab"]')).length === baseline + 2, {
      timeout: 5000,
      timeoutMsg: "the + did not open a second tab",
    });
  });

  it("makes the tab it just opened the active one", async () => {
    const tabs = await $$('[role="tab"]');
    await expect(await tabs[baseline + 1].getAttribute("data-state")).toBe("active");
    await expect(await tabs[baseline].getAttribute("data-state")).toBe("inactive");
  });

  it("switches to another tab on click", async () => {
    const tabs = await $$('[role="tab"]');
    await tabs[baseline].click();

    await browser.waitUntil(
      async () => (await (await $$('[role="tab"]'))[baseline].getAttribute("data-state")) === "active",
      { timeout: 5000, timeoutMsg: "clicking a tab did not activate it" },
    );
  });

  it("closes a tab from the × that is always on it", async () => {
    // Always present, at reduced opacity, rather than revealed on hover —
    // so it is clickable without simulating a hover the webview may or may
    // not deliver the way a real pointer would.
    const close = await $('[aria-label^="Close "]');
    await close.waitForExist({ timeout: 5000 });
    await close.click();

    await browser.waitUntil(async () => (await $$('[role="tab"]')).length === baseline + 1, {
      timeout: 5000,
      timeoutMsg: "the tab did not close",
    });
  });
});
