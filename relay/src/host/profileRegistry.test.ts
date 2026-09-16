import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  allocatePort,
  deleteProfileFiles,
  ensureSelfRegistered,
  envFileFor,
  findHomeOverrideCollision,
  isValidProfileId,
  listProfiles,
  slugify,
  updateProfileMeta,
} from "./profileRegistry.js";

// `envDir` nested one level under the unique tmp root (mirrors the real
// `~/.config/anywh/{env,profiles.json}` layout) — `mkdtempSync` alone
// creates directly under the shared `os.tmpdir()`, so `dirname(envDir)`
// would resolve to that shared `/tmp`, and every test's `profiles.json`
// would collide on the same path instead of each getting its own.
function withTempDir(run: (envDir: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "anywh-profile-registry-test-"));
  const envDir = join(root, "env");
  mkdirSync(envDir);
  return Promise.resolve(run(envDir)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function writeEnv(envDir: string, id: string, values: Record<string, string>): void {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(envFileFor(id, envDir), body);
}

test("isValidProfileId: accepts lowercase alphanumeric + hyphen, rejects the rest", () => {
  assert.equal(isValidProfileId("trabalho"), true);
  assert.equal(isValidProfileId("trabalho-2"), true);
  assert.equal(isValidProfileId("a1"), true);
  assert.equal(isValidProfileId(""), false);
  assert.equal(isValidProfileId("-trabalho"), false);
  assert.equal(isValidProfileId("Trabalho"), false);
  assert.equal(isValidProfileId("trabalho novo"), false);
  assert.equal(isValidProfileId("a".repeat(33)), false);
});

test("slugify: strips accents, lowercases, collapses separators", () => {
  assert.equal(slugify("João Ação", []), "joao-acao");
  assert.equal(slugify("  Cliente   X!! ", []), "cliente-x");
});

test("slugify: appends -2/-3 on collision, keeps first-come untouched", () => {
  assert.equal(slugify("Trabalho", []), "trabalho");
  assert.equal(slugify("Trabalho", ["trabalho"]), "trabalho-2");
  assert.equal(slugify("Trabalho", ["trabalho", "trabalho-2"]), "trabalho-3");
});

test("slugify: caps length at 32 chars", () => {
  const result = slugify("a".repeat(50), []);
  assert.equal(result.length, 32);
});

test("listProfiles: a profile with no profiles.json entry falls back to id as label and position as colorIndex", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001", RELAY_HOST: "127.0.0.1" });
    writeEnv(envDir, "trabalho", { RELAY_PORT: "9002", RELAY_HOST: "127.0.0.1", RELAY_HOME_OVERRIDE: "/tmp/fake-home" });

    const profiles = await listProfiles(envDir);
    assert.equal(profiles.length, 2);

    const pessoal = profiles.find((p) => p.id === "pessoal");
    assert.ok(pessoal);
    assert.equal(pessoal.label, "pessoal");
    assert.equal(pessoal.hasHomeOverride, false);
    assert.equal(pessoal.running, false);

    const trabalho = profiles.find((p) => p.id === "trabalho");
    assert.ok(trabalho);
    assert.equal(trabalho.hasHomeOverride, true);
  });
});

test("listProfiles: profiles.json overrides label and colorIndex", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001", RELAY_HOST: "127.0.0.1" });
    writeFileSync(
      join(envDir, "..", "profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: [{ id: "pessoal", label: "Pessoal", colorIndex: 3, createdAt: "now", updatedAt: "now" }],
      }),
    );

    const profiles = await listProfiles(envDir);
    assert.equal(profiles[0].label, "Pessoal");
    assert.equal(profiles[0].colorIndex, 3);
  });
});

test("listProfiles: ignores a .env file without RELAY_PORT", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "broken", { RELAY_HOST: "127.0.0.1" });
    const profiles = await listProfiles(envDir);
    assert.equal(profiles.length, 0);
  });
});

test("findHomeOverrideCollision: matches a differently-written path to the same real directory", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "trabalho", { RELAY_PORT: "9002", RELAY_HOME_OVERRIDE: "/tmp/fake-home" });
    assert.equal(findHomeOverrideCollision("/tmp/fake-home/", envDir), "trabalho");
    assert.equal(findHomeOverrideCollision("/tmp/other-home", envDir), undefined);
  });
});

test("findHomeOverrideCollision: absence of RELAY_HOME_OVERRIDE means the real $HOME, a comparable value", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    assert.equal(findHomeOverrideCollision(undefined, envDir), "pessoal");
  });
});

test("allocatePort: skips a port already claimed by an existing .env file", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "8765" });
    const port = await allocatePort(envDir);
    assert.notEqual(port, 8765);
  });
});

test("updateProfileMeta: throws for a profile with no .env file", async () => {
  await withTempDir((envDir) => {
    assert.throws(() => updateProfileMeta("ghost", { label: "Ghost" }, envDir));
  });
});

test("updateProfileMeta: fills in the other field from its current fallback (id/position), not from a blank", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    writeEnv(envDir, "trabalho", { RELAY_PORT: "9002" });

    const updated = updateProfileMeta("trabalho", { label: "Trabalho" }, envDir);
    assert.equal(updated.label, "Trabalho");
    assert.equal(updated.colorIndex, 1); // position in the list, since no entry existed yet
  });
});

test("updateProfileMeta: themeId round-trips, and null clears it back to the built-in", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });

    assert.equal(updateProfileMeta("pessoal", { themeId: "nord-ish" }, envDir).themeId, "nord-ish");
    // Patching something else must not drop the theme along the way.
    assert.equal(updateProfileMeta("pessoal", { label: "Pessoal" }, envDir).themeId, "nord-ish");
    assert.equal(updateProfileMeta("pessoal", { themeId: null }, envDir).themeId, undefined);
  });
});

test("listProfiles: reports the profile's themeId, absent when never set", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    writeEnv(envDir, "trabalho", { RELAY_PORT: "9002" });
    updateProfileMeta("trabalho", { themeId: "nord-ish" }, envDir);

    const profiles = await listProfiles(envDir);
    assert.equal(profiles.find((p) => p.id === "trabalho")?.themeId, "nord-ish");
    assert.equal(profiles.find((p) => p.id === "pessoal")?.themeId, undefined);
  });
});

test("updateProfileMeta: id never changes, second call merges onto the first instead of resetting it", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });

    const first = updateProfileMeta("pessoal", { colorIndex: 4 }, envDir);
    assert.equal(first.colorIndex, 4);
    assert.equal(first.label, "pessoal");

    const second = updateProfileMeta("pessoal", { label: "Pessoal" }, envDir);
    assert.equal(second.id, "pessoal");
    assert.equal(second.label, "Pessoal");
    assert.equal(second.colorIndex, 4); // preserved from the first call, not reset to a fallback
    assert.equal(second.createdAt, first.createdAt);
  });
});

test("deleteProfileFiles: removes the .env and the profiles.json entry, nothing else", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    updateProfileMeta("pessoal", { label: "Pessoal" }, envDir);

    deleteProfileFiles("pessoal", envDir);

    assert.equal(existsSync(envFileFor("pessoal", envDir)), false);
    const registry = JSON.parse(readFileSync(join(envDir, "..", "profiles.json"), "utf8")) as {
      profiles: unknown[];
    };
    assert.equal(registry.profiles.length, 0);
  });
});

test("deleteProfileFiles: a profile that was never in profiles.json is still a no-op, not an error", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    assert.doesNotThrow(() => deleteProfileFiles("pessoal", envDir));
    assert.equal(existsSync(envFileFor("pessoal", envDir)), false);
  });
});

test("ensureSelfRegistered: fresh envDir writes default.env with the given port/host", async () => {
  await withTempDir((envDir) => {
    ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    const env = readFileSync(envFileFor("default", envDir), "utf8");
    assert.match(env, /RELAY_PORT=8765/);
    assert.match(env, /RELAY_HOST=127\.0\.0\.1/);
  });
});

test("ensureSelfRegistered: no-op when an existing profile already claims this port", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "8765" });
    ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    assert.equal(existsSync(envFileFor("default", envDir)), false);
  });
});

test("ensureSelfRegistered: no-op when default.env already exists", async () => {
  await withTempDir((envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: "9999", RELAY_HOST: "0.0.0.0" });
    ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    const env = readFileSync(envFileFor("default", envDir), "utf8");
    assert.match(env, /RELAY_PORT=9999/);
  });
});

test("ensureSelfRegistered: makes updateProfileMeta('default', ...) succeed afterward", async () => {
  await withTempDir((envDir) => {
    ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    const updated = updateProfileMeta("default", { label: "X" }, envDir);
    assert.equal(updated.label, "X");
  });
});
