import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_VERSION, UNRELEASED_VERSION } from "@/lib/install/appVersion";

/**
 * The version lives in three manifests — the client's package.json (which
 * `APP_VERSION` reads), tauri.conf.json (which Tauri stamps on the bundle)
 * and the relay's package.json (which `GET /host-info` reports, and which
 * the app compares against its own to spot a stale relay). None of them is
 * ever edited by hand: git keeps all three at the unreleased placeholder,
 * and only the release build stamps a real version into them
 * (`node scripts/version.mjs stamp`, .anywh/skills/release/SKILL.md). So
 * these tests are the rule "PRs don't change the version", enforced: a PR
 * that bumps one of them fails here instead of colliding with every other
 * PR that bumped it too.
 */
// Resolved from the runner's cwd (always `client/`, where vitest.config.ts
// lives) — same reasoning as builtinThemes.test.ts's read of index.css.
function readJson(relativePath: string): { version?: string } {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), "utf8")) as { version?: string };
}

function readText(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("app version", () => {
  it("is the unreleased placeholder in every manifest, never a version committed by hand", () => {
    expect(APP_VERSION).toBe(UNRELEASED_VERSION);
    expect(readJson("src-tauri/tauri.conf.json").version).toBe(UNRELEASED_VERSION);
    expect(readJson("../relay/package.json").version).toBe(UNRELEASED_VERSION);
  });

  it("agrees with the placeholder scripts/version.mjs stamps over and relay_setup.rs refuses to pin", () => {
    expect(readText("../scripts/version.mjs")).toContain(`export const UNRELEASED_VERSION = "${UNRELEASED_VERSION}";`);
    expect(readText("src-tauri/src/relay_setup.rs")).toContain(`const UNRELEASED_VERSION: &str = "${UNRELEASED_VERSION}";`);
  });

  /**
   * Tauri stamps the bundle from `tauri.conf.json`, not from Cargo's own
   * `version` field, so nothing ever reads Cargo.toml's version — it is dead
   * weight `cargo` requires the manifest to have, frozen on purpose. Stamping
   * it too looks like harmless consistency but buys nothing and adds a
   * fourth file to keep in sync for no reason.
   */
  it("leaves Cargo.toml frozen at 0.1.0", () => {
    expect(readText("src-tauri/Cargo.toml")).toMatch(/^version = "0\.1\.0"$/m);
  });
});
