// The status bar in the real Tauri window. With no relay running — the case
// this whole tier lives in — its left half has nothing to say and the right
// half still has to: the version is a build-time constant, so it is the one
// part of this strip that must render in any environment, including one with
// no machine to ask about a repository.
describe("anywh status bar", () => {
  it("prints the running version at the bottom right of the window", async () => {
    // Matched by the title rather than by the number itself: hardcoding the
    // version here would make every release bump a failing e2e run, and the
    // number's agreement with package.json/tauri.conf.json is already
    // pinned by src/lib/appVersion.test.ts.
    const version = await $('//span[starts-with(@title, "anywh ")]');
    await version.waitForExist({ timeout: 15000 });

    const text = await version.getText();
    if (!/^v\d+\.\d+\.\d+/.test(text)) {
      throw new Error(`expected the status bar to show a version, got "${text}"`);
    }
  });

  it("says nothing about git when no relay answers for the session", async () => {
    // The left half is absent, not empty and not an error: a folder nobody
    // can describe produces no branch/changes segment at all (StatusBar.tsx)
    // — the right half (version, locale control) still renders regardless.
    const branch = await $('//span[contains(text(), "·")]');
    if (await branch.isExisting()) {
      throw new Error("expected no branch/changes segment with no relay to answer");
    }
  });
});
