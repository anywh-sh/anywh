import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stopProfileService } from "./profileServices.js";

// The real launchctl reaches the user's live launchd session; this stands in
// for it (as fake-systemctl.mjs does for systemd).
const FAKE_LAUNCHCTL = resolve(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/fake-launchctl.sh");

function withLaunchd(fn: (dir: string, env: NodeJS.ProcessEnv, calls: () => string[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "anywh-launchd-"));
  const argvFile = join(dir, "argv");
  const env = { PATH: process.env.PATH, ANYWH_RELAY_MANAGED_BY_APP: "1", ANYWH_LAUNCHD_DIR: dir, LAUNCHCTL_BIN: FAKE_LAUNCHCTL, FAKE_LAUNCHCTL_ARGV_FILE: argvFile };
  const calls = () => readFileSync(argvFile, "utf8").trim().split("\n");
  return fn(dir, env, calls).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the app's relay: stopping a profile's service boots its launchd job out and removes its plist", () =>
  withLaunchd(async (dir, env, calls) => {
    const plist = join(dir, "sh.anywh.agent-host.work.plist");
    writeFileSync(plist, "");
    assert.deepEqual(await stopProfileService("agent-host", "work", env), { stopped: true });
    assert.equal(existsSync(plist), false, "the app must never bootstrap a deleted profile again");
    const uid = process.getuid!();
    assert.deepEqual(calls(), [`bootout gui/${uid}/sh.anywh.agent-host.work`, `print gui/${uid}/sh.anywh.agent-host.work`]);
  }));

test("the app's relay: a job still loaded once the wait is over is not reported stopped", () =>
  withLaunchd(async (_dir, env) => {
    const result = await stopProfileService("agent-host", "work", { ...env, FAKE_LAUNCHCTL_LOADED: "sh.anywh.agent-host.work" }, 600);
    assert.equal(result.stopped, false);
    assert.match(result.detail ?? "", /still loaded/);
  }));

test("the app's relay: a job that takes a while to go after bootout is waited for", () =>
  withLaunchd(async (dir, env) => {
    const loadedFile = join(dir, "loaded");
    writeFileSync(loadedFile, "sh.anywh.agent-host.work");
    setTimeout(() => rmSync(loadedFile), 700);
    assert.deepEqual(await stopProfileService("agent-host", "work", { ...env, FAKE_LAUNCHCTL_LOADED_FILE: loadedFile }, 10_000), { stopped: true });
  }));

test("a relay not run by the app stops systemd units, never launchd jobs", () =>
  withLaunchd(async (dir, env) => {
    const result = await stopProfileService("relay", "work", {
      ...env,
      ANYWH_RELAY_MANAGED_BY_APP: undefined,
      SYSTEMCTL_BIN: resolve(dirname(FAKE_LAUNCHCTL), "fake-systemctl.mjs"),
    });
    assert.deepEqual(result, { stopped: true });
    assert.equal(existsSync(join(dir, "argv")), false, "launchctl must not be called");
  }));
