import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e2eSeedPort, firstRunE2EFixtures } from "../../wdio.conf.js";
import { startRelay } from "./fixtures/startRelay.js";

// anywh already on this machine, in the real Tauri window: an install the
// real disk probe (relay_setup.rs, under the throwaway HOME of wdio.conf.js)
// finds — the relay tree, a profile's .env and its profiles.json entry —
// with a real relay of this checkout answering on that profile's port.
// "Set up on this machine" then adopts it, installing nothing, and goes on
// to its agents and the shell.

const { home, adoptDir } = firstRunE2EFixtures;
const installMarker = join(home, ".local/share/anywh/relay/dist/server.js");
const envDir = join(home, ".config/anywh/env");
const registry = join(home, ".config/anywh/profiles.json");

const byText = (text) => $(`//*[normalize-space(text())="${text}"]`);
const button = (text) => $(`//button[normalize-space()="${text}"]`);

let relayPid = null;

describe("anywh onboarding — adopting an existing install", () => {
  before(async () => {
    mkdirSync(join(home, ".local/share/anywh/relay/dist"), { recursive: true });
    writeFileSync(installMarker, "");
    // The relay reads the same profile directory the probe does, so it is
    // the "pessoal" profile it finds there — as add-profile.sh sets it up —
    // rather than registering itself as a stray "default".
    const { pid } = await startRelay(adoptDir, {
      envDir,
      beforeStart: (port) => {
        writeFileSync(join(envDir, "pessoal.env"), `RELAY_PORT=${String(port)}\nRELAY_HOST=127.0.0.1\n`);
        writeFileSync(registry, JSON.stringify({ version: 1, profiles: [{ id: "pessoal", label: "Pessoal", colorIndex: 0 }] }));
      },
    });
    relayPid = pid;
    writeFileSync(join(adoptDir, "relay.pid"), `${String(pid)}\n`);

    await browser.execute(() => {
      localStorage.setItem("anywh:profiles", "[]");
      localStorage.removeItem("anywh:first-run:pending-agents");
      localStorage.removeItem("anywh:first-run:adopting");
      localStorage.setItem("anywh:locale", "en");
      window.location.reload();
    });
    await byText("Your coding agents, wherever you are.").waitForExist({ timeout: 15000 });
  });

  it("adopts the profile it finds, installs nothing, and starts with the agent picked", async () => {
    await (await button("Set up on this machine")).click();
    const start = await button("Start with Claude Code");
    await start.waitForExist({ timeout: 60000 });
    await start.click();
    await $('[aria-label="New session"]').waitForExist({ timeout: 20000 });

    const profiles = await browser.execute(() => JSON.parse(localStorage.getItem("anywh:profiles") ?? "[]"));
    expect(profiles.map((p) => [p.id, p.host, p.localRelay === true])).toEqual([["pessoal", "127.0.0.1", true]]);
    // Nothing was installed: the installer was never asked to run.
    expect(() => readFileSync(join(firstRunE2EFixtures.installDir, "relay.pid"))).toThrow();
  });

  after(async () => {
    if (relayPid !== null) {
      try {
        process.kill(relayPid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(join(adoptDir, "relay.pid"), { force: true });
    rmSync(installMarker, { force: true });
    rmSync(join(envDir, "pessoal.env"), { force: true });
    rmSync(registry, { force: true });
    await browser.execute((port) => {
      localStorage.setItem("anywh:profiles", JSON.stringify([{ id: "e2e", label: "Default", host: "127.0.0.1", relayPort: port }]));
      localStorage.removeItem("anywh:first-run:pending-agents");
      window.location.reload();
    }, e2eSeedPort);
    await $('[aria-label="New session"]').waitForExist({ timeout: 15000 });
  });
});
