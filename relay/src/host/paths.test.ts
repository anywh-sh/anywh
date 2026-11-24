import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCwd, profileDataDirs, resolveShipped } from "./paths.js";

test("defaultCwd falls back to the real home directory", () => {
  assert.equal(defaultCwd(undefined), homedir());
  assert.equal(defaultCwd("/custom/home"), "/custom/home");
});

test("resolveShipped resolves relative to the calling file outside a SEA build", () => {
  // Every real caller (the test process itself, `tsx` in dev, the Linux
  // tarball's `dist/`) hits this branch — `isSea()` is only ever true
  // inside the macOS SEA binary this module also supports, which nothing
  // in this test suite runs as.
  const here = import.meta.url;
  assert.equal(resolveShipped(here, "../../scripts", "scripts"), resolve(dirname(fileURLToPath(here)), "../../scripts"));
});

test("profileDataDirs: a profile with its own data root keeps rooms and bots there", () => {
  const dirs = profileDataDirs({ RELAY_DATA_DIR: "/p/work" }, undefined);
  assert.deepEqual(dirs, { root: "/p/work", rooms: "/p/work/rooms", bots: "/p/work/bots", ownRoot: true });
});

test("profileDataDirs: a profile without one keeps them where they always were, under its home", () => {
  assert.deepEqual(profileDataDirs({}, "/custom/home"), {
    root: "/custom/home/.anywh",
    rooms: "/custom/home/.anywh/rooms",
    bots: "/custom/home/.anywh/bots",
    ownRoot: false,
  });
  assert.equal(profileDataDirs({}, undefined).root, join(homedir(), ".anywh"));
});

test("profileDataDirs: a feature's own variable still wins over the root", () => {
  const dirs = profileDataDirs({ RELAY_DATA_DIR: "/p/work", RELAY_ROOM_CONTEXT_DIR: "/r", RELAY_BOT_DIR: "/b" }, undefined);
  assert.equal(dirs.rooms, "/r");
  assert.equal(dirs.bots, "/b");
  // An empty value is no value: systemd's EnvironmentFile can't unset one.
  assert.equal(profileDataDirs({ RELAY_DATA_DIR: "" }, "/h").root, "/h/.anywh");
});
