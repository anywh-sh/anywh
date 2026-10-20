// How the npm scripts pick a profile: `dev` pairs relay and host on a
// separate `dev` profile; `start` (what the self-hosting docs run) never
// forces one, so ANYWH_PROFILE from relay/.env keeps deciding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const scripts = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

test("dev scripts share the `dev` profile; start scripts never force one", () => {
  assert.match(scripts.dev, /ANYWH_PROFILE=\$\{ANYWH_PROFILE:-dev\}/);
  assert.match(scripts["dev:agent-host"], /--profile dev\b/);
  assert.doesNotMatch(scripts.start, /ANYWH_PROFILE/);
  assert.doesNotMatch(scripts["start:agent-host"], /--profile dev\b/);
  // The host still never takes a profile implicitly: this script opts in to
  // reading it from the env it loaded (relay/.env included).
  assert.match(scripts["start:agent-host"], /--profile-from-env/);
});
