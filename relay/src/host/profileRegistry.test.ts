import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePort,
  deleteProfileFiles,
  ensureSelfRegistered,
  envFileFor,
  findHomeOverrideCollision,
  isValidProfileId,
  listProfileIds,
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
    assert.equal(await findHomeOverrideCollision("/tmp/fake-home/", envDir), "trabalho");
    assert.equal(await findHomeOverrideCollision("/tmp/other-home", envDir), undefined);
  });
});

test("findHomeOverrideCollision: absence of RELAY_HOME_OVERRIDE means the real $HOME, a comparable value", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "9001" });
    assert.equal(await findHomeOverrideCollision(undefined, envDir), "pessoal");
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
  await withTempDir(async (envDir) => {
    assert.equal(await ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir), "written");
    const env = readFileSync(envFileFor("default", envDir), "utf8");
    assert.match(env, /RELAY_PORT=8765/);
    assert.match(env, /RELAY_HOST=127\.0\.0\.1/);
  });
});

test("ensureSelfRegistered: a fresh write lands before the returned promise settles", async () => {
  await withTempDir(async (envDir) => {
    const pending = ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    assert.ok(existsSync(envFileFor("default", envDir)));
    assert.equal(await pending, "written");
  });
});

test("ensureSelfRegistered: no-op when an existing profile already claims this port", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "pessoal", { RELAY_PORT: "8765" });
    assert.equal(await ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir), "skipped");
    assert.equal(existsSync(envFileFor("default", envDir)), false);
  });
});

test("ensureSelfRegistered: leaves a default.env registered in profiles.json alone", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "0.0.0.0" });
    updateProfileMeta("default", { label: "Default" }, envDir);
    const before = readFileSync(envFileFor("default", envDir), "utf8");

    assert.equal(await ensureSelfRegistered({ port: 28765, host: "127.0.0.1" }, envDir), "skipped");
    assert.equal(readFileSync(envFileFor("default", envDir), "utf8"), before);
  });
});

test("ensureSelfRegistered: leaves a default.env whose port still answers alone", async () => {
  await withTempDir(async (envDir) => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const { port } = server.address() as { port: number };
      writeEnv(envDir, "default", { RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1" });

      assert.equal(await ensureSelfRegistered({ port: 28765, host: "127.0.0.1" }, envDir), "skipped");
      assert.match(readFileSync(envFileFor("default", envDir), "utf8"), new RegExp(`RELAY_PORT=${port}`));
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

test("ensureSelfRegistered: never replaces a default.env add-profile.sh wrote, even unregistered", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1", RELAY_SESSIONS_FILE: "/x" });
    const before = readFileSync(envFileFor("default", envDir), "utf8");

    assert.equal(await ensureSelfRegistered({ port: 28765, host: "127.0.0.1" }, envDir), "skipped");
    assert.equal(readFileSync(envFileFor("default", envDir), "utf8"), before);
  });
});

test("ensureSelfRegistered: replaces an unregistered default.env nothing listens on", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "192.168.0.48" });

    assert.equal(await ensureSelfRegistered({ port: 28765, host: "127.0.0.1" }, envDir), "replaced");
    const env = readFileSync(envFileFor("default", envDir), "utf8");
    assert.match(env, /RELAY_PORT=28765/);
    assert.match(env, /RELAY_HOST=127\.0\.0\.1/);
  });
});

test("ensureSelfRegistered: never rewrites a default.env that already holds this process's port", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: "28765", RELAY_HOST: "0.0.0.0" });

    assert.equal(await ensureSelfRegistered({ port: 28765, host: "127.0.0.1" }, envDir), "skipped");
    assert.match(readFileSync(envFileFor("default", envDir), "utf8"), /RELAY_HOST=0\.0\.0\.0/);
  });
});

test("ensureSelfRegistered: makes updateProfileMeta('default', ...) succeed afterward", async () => {
  await withTempDir(async (envDir) => {
    await ensureSelfRegistered({ port: 8765, host: "127.0.0.1" }, envDir);
    const updated = updateProfileMeta("default", { label: "X" }, envDir);
    assert.equal(updated.label, "X");
  });
});

// A port nothing listens on: bound and released, so the probe in `listProfiles` reports it as not running.
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

test("listProfiles: hides a default.env that profiles.json doesn't know and nothing listens on", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });
    writeEnv(envDir, "pessoal", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });

    assert.deepEqual((await listProfiles(envDir)).map((p) => p.id), ["pessoal"]);
  });
});

test("listProfiles: lists that default once it is registered, even when not running", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });
    updateProfileMeta("default", { label: "Default" }, envDir);

    const profiles = await listProfiles(envDir);
    assert.deepEqual(profiles.map((p) => p.id), ["default"]);
    assert.equal(profiles[0].running, false);
  });
});

test("listProfiles: lists an unregistered default while it is running", async () => {
  await withTempDir(async (envDir) => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const { port } = server.address() as { port: number };
      writeEnv(envDir, "default", { RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1" });

      const profiles = await listProfiles(envDir);
      assert.deepEqual(profiles.map((p) => p.id), ["default"]);
      assert.equal(profiles[0].running, true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

test("listProfiles: hiding the orphan default never shifts another profile's fallback colorIndex", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });
    writeEnv(envDir, "pessoal", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });

    const before = (await listProfiles(envDir)).find((p) => p.id === "pessoal");
    // Registering the default makes it visible; the other profile must keep its slot.
    updateProfileMeta("default", { label: "Default" }, envDir);
    const after = (await listProfiles(envDir)).find((p) => p.id === "pessoal");

    assert.ok(before && after);
    assert.equal(after.colorIndex, before.colorIndex);
  });
});

test("listProfileIds: includes the hidden orphan default, so a new profile never takes its id", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });

    assert.deepEqual(listProfileIds(envDir), ["default"]);
    assert.equal(slugify("Default", listProfileIds(envDir)), "default-2");
  });
});

test("allocatePort: still skips the port of a hidden orphan default", async () => {
  await withTempDir(async (envDir) => {
    // What allocatePort would hand out with nothing on disk.
    const first = await allocatePort(envDir);
    writeEnv(envDir, "default", { RELAY_PORT: String(first), RELAY_HOST: "127.0.0.1" });

    assert.notEqual(await allocatePort(envDir), first);
  });
});

test("findHomeOverrideCollision: ignores a hidden orphan default", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });

    assert.equal(await findHomeOverrideCollision(undefined, envDir), undefined);
  });
});

test("findHomeOverrideCollision: still reports an unregistered default while it is running", async () => {
  await withTempDir(async (envDir) => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const { port } = server.address() as { port: number };
      writeEnv(envDir, "default", { RELAY_PORT: String(port), RELAY_HOST: "127.0.0.1" });

      assert.equal(await findHomeOverrideCollision(undefined, envDir), "default");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

test("findHomeOverrideCollision: still reports a registered default that is stopped", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });
    updateProfileMeta("default", { label: "Default" }, envDir);

    assert.equal(await findHomeOverrideCollision(undefined, envDir), "default");
  });
});

test("findHomeOverrideCollision: an orphan default never hides another profile with the same home", async () => {
  await withTempDir(async (envDir) => {
    writeEnv(envDir, "default", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });
    writeEnv(envDir, "pessoal", { RELAY_PORT: String(await closedPort()), RELAY_HOST: "127.0.0.1" });

    assert.equal(await findHomeOverrideCollision(undefined, envDir), "pessoal");
  });
});
