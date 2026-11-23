// The self-update end to end, minus the network: the real install-relay.sh,
// run by the real RelayUpdater, against a real release tarball and
// SHA256SUMS served from localhost (ANYWH_RELEASE_BASE_URL, the installer's
// own seam for tests and mirrors), into a throwaway install dir. `--mode dev`
// (no service manager here) keeps it away from the machine's real systemd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RelayUpdater, updateSupport, type RelayUpdateStatus } from "./relayUpdater.js";

const INSTALLER = resolve(import.meta.dirname, "../../../install-relay.sh");
const TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** A relay tree as the release tarball lays it out, at `version`: its
 * server answers `/host-info` with that version on RELAY_PORT, as the
 * installer's boot check expects — or, `broken`, dies at once like a release
 * whose native module cannot load on this machine. */
function writeTree(root: string, version: string, options: { broken?: boolean } = {}): void {
  mkdirSync(join(root, "relay", "dist"), { recursive: true });
  mkdirSync(join(root, "infra", "systemd"), { recursive: true });
  const server = options.broken
    ? `// relay ${version}\nconsole.error("Error: Failed to load native module: pty.node (GLIBC_2.42 not found)");\nprocess.exit(1);\n`
    : `// relay ${version}\nrequire("http").createServer((req, res) => res.end(JSON.stringify({ version: ${JSON.stringify(version)} }))).listen(Number(process.env.RELAY_PORT), "127.0.0.1");\n`;
  writeFileSync(join(root, "relay", "dist", "server.js"), server);
  writeFileSync(join(root, "relay", "package.json"), JSON.stringify({ name: "anywh-relay", version }));
  writeFileSync(join(root, "infra", "systemd", "add-profile.sh"), "#!/bin/sh\n");
  copyFileSync(INSTALLER, join(root, "infra", "install-relay.sh"));
}

interface Release {
  baseUrl: string;
  server: Server;
}

/** Serves `anywh-relay-<version>-<target>.tar.gz` and its SHA256SUMS, with
 * the sum optionally wrong. */
async function serveRelease(dir: string, version: string, options: { corruptSum?: boolean; broken?: boolean } = {}): Promise<Release> {
  const stage = join(dir, `stage-${version}`);
  writeTree(stage, version, { broken: options.broken });
  const asset = `anywh-relay-${version}-${TARGET}.tar.gz`;
  const assetPath = join(dir, asset);
  execFileSync("tar", ["czf", assetPath, "-C", stage, "relay", "infra"]);
  const bytes = readFileSync(assetPath);
  const sum = options.corruptSum ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
  const sums = `${sum}  ${asset}\n`;
  const server = createServer((req, res) => {
    if (req.url === `/${asset}`) return void res.end(bytes);
    if (req.url === "/SHA256SUMS") return void res.end(sums);
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function versionIn(relayDir: string): unknown {
  return (JSON.parse(readFileSync(join(relayDir, "package.json"), "utf8")) as { version?: unknown }).version;
}

async function settled(updater: RelayUpdater): Promise<RelayUpdateStatus> {
  const deadline = Date.now() + 25_000;
  while (updater.status().state === "installing") {
    if (Date.now() > deadline) throw new Error("the install did not finish");
    await new Promise((r) => setTimeout(r, 50));
  }
  return updater.status();
}

function setup(running: string) {
  const dir = mkdtempSync(join(tmpdir(), "anywh-self-update-"));
  const installDir = join(dir, "install");
  writeTree(installDir, running);
  return { dir, installDir, relayDir: join(installDir, "relay") };
}

function updaterFor(relayDir: string, running: string, baseUrl: string, installed: string[] = []): RelayUpdater {
  return new RelayUpdater({
    runningVersion: running,
    relayDir,
    sea: false,
    withService: false,
    env: { ...process.env, ANYWH_RELEASE_BASE_URL: baseUrl, ANYWH_SKIP_AGENT_LOGIN_CHECK: "1", AGENT_BIN: "true" },
    onInstalled: (version) => installed.push(version),
  });
}

test("a newer release is downloaded, verified and swapped in over the running tree, keeping the relay's own files", async () => {
  const { dir, installDir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41");
  // What the release does not ship and a relay keeps beside its code.
  writeFileSync(join(relayDir, ".env"), "AGENT_BIN=/opt/claude\n");
  writeFileSync(join(relayDir, "push-devices.local.json"), "{}");
  try {
    const installed: string[] = [];
    const updater = updaterFor(relayDir, "0.2.40", release.baseUrl, installed);
    const started = updater.start("v0.2.41");
    assert.equal(started.ok, true);
    assert.deepEqual(started.status, { state: "installing", version: "0.2.41" });
    // Asking again for the same release while it installs is not an error.
    assert.equal(updater.start("0.2.41").ok, true);

    assert.deepEqual(await settled(updater), { state: "installed", version: "0.2.41" });
    assert.deepEqual(installed, ["0.2.41"]);
    assert.equal(versionIn(relayDir), "0.2.41");
    assert.match(readFileSync(join(relayDir, "dist", "server.js"), "utf8"), /relay 0\.2\.41/);
    // The new tree carries the installer for the update after this one.
    readFileSync(join(installDir, "infra", "install-relay.sh"));
    // The relay's own files came along; the release's files are the new ones.
    assert.equal(readFileSync(join(relayDir, ".env"), "utf8"), "AGENT_BIN=/opt/claude\n");
    assert.equal(readFileSync(join(relayDir, "push-devices.local.json"), "utf8"), "{}");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two profiles asking at once on one machine get one install, the tree intact and its files kept", async () => {
  const { dir, installDir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41");
  writeFileSync(join(relayDir, ".env"), "AGENT_BIN=/opt/claude\n");
  try {
    // Two relays (profiles) sharing this tree, each with its own updater.
    const first = updaterFor(relayDir, "0.2.40", release.baseUrl);
    const second = updaterFor(relayDir, "0.2.40", release.baseUrl);
    assert.equal(first.start("0.2.41").ok, true);
    assert.equal(second.start("0.2.41").ok, true);
    assert.deepEqual(await settled(first), { state: "installed", version: "0.2.41" });
    assert.deepEqual(await settled(second), { state: "installed", version: "0.2.41" });
    assert.equal(versionIn(relayDir), "0.2.41");
    assert.equal(existsSync(join(relayDir, "relay")), false, "no tree nested inside the other");
    assert.equal(readFileSync(join(relayDir, ".env"), "utf8"), "AGENT_BIN=/opt/claude\n");
    assert.equal(existsSync(join(installDir, ".install.lock")), false, "the lock is released");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tarball that fails its checksum is refused and the running tree is left as it was", async () => {
  const { dir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41", { corruptSum: true });
  try {
    const installed: string[] = [];
    const updater = updaterFor(relayDir, "0.2.40", release.baseUrl, installed);
    assert.equal(updater.start("0.2.41").ok, true);
    const status = await settled(updater);
    assert.equal(status.state, "failed");
    assert.equal(status.state === "failed" && status.code, "checksum_mismatch");
    assert.deepEqual(installed, []);
    assert.equal(versionIn(relayDir), "0.2.40");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release that cannot start on this machine is never swapped in: the running tree stays", async () => {
  const { dir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41", { broken: true });
  writeFileSync(join(relayDir, ".env"), "AGENT_BIN=/opt/claude\n");
  try {
    const installed: string[] = [];
    const updater = updaterFor(relayDir, "0.2.40", release.baseUrl, installed);
    assert.equal(updater.start("0.2.41").ok, true);
    const status = await settled(updater);
    assert.equal(status.state === "failed" && status.code, "preflight_failed");
    assert.match(status.state === "failed" ? status.message : "", /GLIBC_2\.42/, "the reason names what failed");
    assert.deepEqual(installed, []);
    assert.equal(versionIn(relayDir), "0.2.40");
    assert.equal(readFileSync(join(relayDir, ".env"), "utf8"), "AGENT_BIN=/opt/claude\n");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release that does not exist fails with the installer's own reason", async () => {
  const { dir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41");
  try {
    const updater = updaterFor(relayDir, "0.2.40", release.baseUrl);
    assert.equal(updater.start("0.2.42").ok, true);
    const status = await settled(updater);
    assert.equal(status.state === "failed" && status.code, "download_failed");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never a downgrade, a reinstall or a version that is not a release; nothing runs for those", () => {
  const { dir, relayDir } = setup("0.2.40");
  try {
    const updater = updaterFor(relayDir, "0.2.40", "http://127.0.0.1:9");
    assert.deepEqual(updater.start("0.2.39"), { ok: false, code: "not_newer", status: { state: "idle" } });
    assert.deepEqual(updater.start("0.2.40"), { ok: false, code: "not_newer", status: { state: "idle" } });
    assert.deepEqual(updater.start("latest"), { ok: false, code: "bad_version", status: { state: "idle" } });
    assert.deepEqual(updater.start("0.0.0"), { ok: false, code: "bad_version", status: { state: "idle" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure before the installer even starts is an error, never a stuck install", () => {
  const { dir, installDir, relayDir } = setup("0.2.40");
  try {
    const updater = updaterFor(relayDir, "0.2.40", "http://127.0.0.1:9");
    // The installer goes away after the updater found it: copying it fails.
    rmSync(join(installDir, "infra", "install-relay.sh"));
    const result = updater.start("0.2.41");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "start_failed");
    assert.equal(updater.status().state, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a tree the installer laid out, running a release, can update itself", () => {
  const { dir, relayDir } = setup("0.2.40");
  try {
    assert.equal(updateSupport({ runningVersion: "0.2.40", relayDir, sea: false }).supported, true);
    assert.deepEqual(updateSupport({ runningVersion: "0.0.0", relayDir, sea: false }), { supported: false, reason: "source_checkout" });
    // The Homebrew build is Homebrew's to update.
    assert.deepEqual(updateSupport({ runningVersion: "0.2.40", relayDir, sea: true }), { supported: false, reason: "managed_elsewhere" });
    rmSync(join(dir, "install", "infra"), { recursive: true });
    assert.deepEqual(updateSupport({ runningVersion: "0.2.40", relayDir, sea: false }), { supported: false, reason: "not_installer_layout" });
    const updater = updaterFor(relayDir, "0.2.40", "http://127.0.0.1:9");
    assert.deepEqual(updater.start("0.2.41"), { ok: false, code: "unsupported", status: { state: "unsupported", reason: "not_installer_layout" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
