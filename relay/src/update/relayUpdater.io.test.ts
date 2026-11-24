// The self-update end to end, minus the network: the real install-relay.sh,
// run by the real RelayUpdater, against a real release tarball and
// SHA256SUMS served from localhost (ANYWH_RELEASE_BASE_URL, the installer's
// own seam for tests and mirrors), into a throwaway install dir. `--mode dev`
// (no service manager here) keeps it away from the machine's real systemd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RelayUpdater, updateSupport, type RelayUpdateStatus } from "./relayUpdater.js";

const INSTALLER = resolve(import.meta.dirname, "../../../install-relay.sh");
const TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** How a release's processes behave when the installer boots it:
 * - `ok`: the server answers `/host-info` with the tree's version on
 *   RELAY_PORT, and the agent host listens on its `--socket`;
 * - `broken`: the server dies at once, like a release whose native module
 *   cannot load on this machine;
 * - `wrongVersion`: the server answers, as another version;
 * - `hang`: the server never answers and ignores SIGTERM, and so does a
 *   child it spawns; both pids go to `pidFile`, so the test can tell they
 *   were killed;
 * - `brokenHost`: the server is fine, the agent host dies at once. */
type Behavior =
  | { kind: "ok" }
  | { kind: "broken" }
  | { kind: "wrongVersion"; answers: string }
  | { kind: "hang"; pidFile: string }
  | { kind: "brokenHost" };

function serverSource(version: string, behavior: Behavior): string {
  const listen = (answer: string) =>
    `require("http").createServer((req, res) => res.end(JSON.stringify({ version: ${JSON.stringify(answer)} }))).listen(Number(process.env.RELAY_PORT), "127.0.0.1");\n`;
  switch (behavior.kind) {
    case "broken":
      return `// relay ${version}\nconsole.error("Error: Failed to load native module: pty.node (GLIBC_2.42 not found)");\nprocess.exit(1);\n`;
    case "wrongVersion":
      return `// relay ${version}\n${listen(behavior.answers)}`;
    case "hang":
      // With a child of its own that ignores SIGTERM too, as an agent CLI
      // probe it started at boot would be.
      return [
        `// relay ${version}`,
        `const child = require("child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });`,
        `require("fs").writeFileSync(${JSON.stringify(behavior.pidFile)}, JSON.stringify([process.pid, child.pid]));`,
        `process.on("SIGTERM", () => {});`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n");
    case "ok":
    case "brokenHost":
      return `// relay ${version}\n${listen(version)}`;
  }
}

function agentHostSource(behavior: Behavior): string {
  return behavior.kind === "brokenHost"
    ? `console.error("node:internal/modules/esm/resolve:873");\nconsole.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node-pty' imported from dist/agentHost/claudeProcess.js");\nconsole.error("");\nconsole.error("Node.js " + process.version);\nprocess.exit(1);\n`
    : `require("net").createServer().listen(process.argv[process.argv.indexOf("--socket") + 1]);\n`;
}

/** A relay tree as the release tarball lays it out, at `version`, its
 * processes behaving as `behavior` says. */
function writeTree(root: string, version: string, behavior: Behavior = { kind: "ok" }): void {
  mkdirSync(join(root, "relay", "dist", "agentHost"), { recursive: true });
  mkdirSync(join(root, "infra", "systemd"), { recursive: true });
  writeFileSync(join(root, "relay", "dist", "server.js"), serverSource(version, behavior));
  writeFileSync(join(root, "relay", "dist", "agentHost", "main.js"), agentHostSource(behavior));
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
async function serveRelease(dir: string, version: string, options: { corruptSum?: boolean; behavior?: Behavior } = {}): Promise<Release> {
  const stage = join(dir, `stage-${version}`);
  writeTree(stage, version, options.behavior);
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

function updaterFor(relayDir: string, running: string, baseUrl: string, installed: string[] = [], env: NodeJS.ProcessEnv = {}): RelayUpdater {
  return new RelayUpdater({
    runningVersion: running,
    relayDir,
    sea: false,
    withService: false,
    env: { ...process.env, ANYWH_RELEASE_BASE_URL: baseUrl, ANYWH_SKIP_AGENT_LOGIN_CHECK: "1", AGENT_BIN: "true", ...env },
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
    assert.equal(status.state === "failed" && status.step, "download", "the step that failed is named");
    assert.deepEqual(installed, []);
    assert.equal(versionIn(relayDir), "0.2.40");
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release that cannot start on this machine is never swapped in: the running tree stays", async () => {
  const { dir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41", { behavior: { kind: "broken" } });
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

/** Runs one update of the tree `setup` laid out to a release behaving as
 * `behavior`, with the installer's temp files in a directory of the test's
 * own, and returns how it ended. */
async function refusedUpdate(behavior: Behavior, env: NodeJS.ProcessEnv = {}) {
  const { dir, relayDir } = setup("0.2.40");
  const release = await serveRelease(dir, "0.2.41", { behavior });
  const scratch = join(dir, "tmp");
  mkdirSync(scratch);
  try {
    const installed: string[] = [];
    const updater = updaterFor(relayDir, "0.2.40", release.baseUrl, installed, { TMPDIR: scratch, ...env });
    assert.equal(updater.start("0.2.41").ok, true);
    const status = await settled(updater);
    assert.equal(status.state === "failed" && status.code, "preflight_failed");
    assert.deepEqual(installed, []);
    assert.equal(versionIn(relayDir), "0.2.40");
    // The throwaway state the release booted with went with the installer.
    assert.deepEqual(readdirSync(scratch), [], "no preflight directory left behind");
    return status.state === "failed" ? status.message : "";
  } finally {
    release.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a release that answers as another version is never swapped in, and says so", async () => {
  const message = await refusedUpdate({ kind: "wrongVersion", answers: "0.2.39" });
  assert.match(message, /answered as version 0\.2\.39 instead of 0\.2\.41/);
});

test("a release that never answers and ignores SIGTERM is refused on time and killed", async () => {
  const pidFile = join(tmpdir(), `anywh-preflight-hang-${process.pid}-${Date.now()}`);
  try {
    const started = Date.now();
    const message = await refusedUpdate({ kind: "hang", pidFile }, { ANYWH_PREFLIGHT_TIMEOUT: "1", ANYWH_PREFLIGHT_STOP_GRACE: "1" });
    assert.match(message, /didn't answer within 1s/);
    assert.ok(Date.now() - started < 15_000, "the deadline and the stop grace bound the wait");
    const [pid, childPid] = JSON.parse(readFileSync(pidFile, "utf8")) as [number, number];
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the release that ignored SIGTERM was killed");
    // Its process group goes with it where the installer has setsid (Linux).
    if (process.platform === "linux") {
      // Re-parented to init when its parent died, then reaped there: give that a moment.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && alive(childPid)) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(childPid), false, "what the release spawned was killed with it");
    } else if (alive(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  } finally {
    rmSync(pidFile, { force: true });
  }
});

test("a release whose agent host cannot start is never swapped in: the reason is the error, not Node's trailer", async () => {
  const message = await refusedUpdate({ kind: "brokenHost" });
  assert.match(message, /agent host 0\.2\.41 exited/);
  assert.match(message, /Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package 'node-pty'/);
  assert.doesNotMatch(message, /Node\.js v/);
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
    assert.deepEqual(updateSupport({ runningVersion: "0.2.40", relayDir, sea: true, managedByApp: true }), { supported: false, reason: "managed_by_app" });
    rmSync(join(dir, "install", "infra"), { recursive: true });
    assert.deepEqual(updateSupport({ runningVersion: "0.2.40", relayDir, sea: false }), { supported: false, reason: "not_installer_layout" });
    const updater = updaterFor(relayDir, "0.2.40", "http://127.0.0.1:9");
    assert.deepEqual(updater.start("0.2.41"), { ok: false, code: "unsupported", status: { state: "unsupported", reason: "not_installer_layout" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
