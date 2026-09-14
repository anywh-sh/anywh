// Builds the relay as a Node Single Executable Application (SEA) for macOS
// — the Homebrew formula's alternative to a shared `depends_on "node"`,
// which turned out to have a sharp edge nobody designed for: `brew
// uninstall anywh-relay` autoremoves Node along with it whenever Node was
// only ever pulled in as this formula's dependency, even if the user has
// since started relying on that same Node for unrelated work. Bundling our
// own runtime makes anywh-relay's presence on a machine have zero bearing
// on whether Node exists there at all.
//
// Two things a plain "bundle with esbuild" doesn't get for free, both
// found building this:
//
// - `node-pty` is a native addon (`pty.node`) and can't be inlined into
//   the SEA blob — Node SEA only supports shipping those as real files
//   the binary loads from disk. `node-pty-shim.cjs` is what
//   `require("node-pty")` resolves to inside the bundle instead of the
//   real package; it does the one thing a plain `require` can't do inside
//   a SEA (which has no filesystem location of its own to resolve
//   against) — build a `createRequire` scope rooted at the real
//   `node_modules/node-pty` this script ships flat beside the binary.
// - The blob `--experimental-sea-config` writes is tied to the exact Node
//   build that generated it — injecting it into a binary of a different
//   Node version crashes on startup with an opaque V8 error
//   ("v8::ToLocalChecked Empty MaybeLocal"), not a helpful version-mismatch
//   message. `NODE_VERSION` below is downloaded fresh for both roles
//   (generating the blob, and the binary it's injected into) instead of
//   trusting whatever Node happens to be running this script, so the two
//   are always the same build regardless of what CI's `setup-node` step
//   installed for everything else in this job.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const relayDir = join(here, "..");
const repoRoot = join(relayDir, "..");

const NODE_VERSION = "22.20.0";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// Only what the formula ships today (its own `depends_on arch: :arm64`).
// Linux keeps the shared-Node model install.sh already documents — adding
// a target here is how that changes, one platform at a time.
const TARGETS = new Set(["darwin-arm64"]);

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag === -1 ? `${hostPlatform()}-${hostArch()}` : process.argv[targetFlag + 1];
if (!TARGETS.has(target)) {
  console.error(`unknown target ${target} — known: ${[...TARGETS].join(", ")}`);
  process.exit(1);
}

const distEntry = join(relayDir, "dist", "server.js");
if (!existsSync(distEntry)) {
  console.error(`${distEntry} doesn't exist — run "npm run build" in relay/ first.`);
  process.exit(1);
}
// Not dist/server.js directly — sea-entry.mjs applies RELAY_ENV_FILE (see
// its own comment) before dynamically importing it, so the profile's .env
// is in process.env ahead of server.ts's own module-level reads and
// everything it imports.
const seaEntry = join(here, "sea-entry.cjs");

const cacheDir = join(here, ".node-cache");

// Node's own dist tarball names are already `<platform>-<arch>`, matching
// `process.platform`/`process.arch` exactly — nothing to translate.
function nodeBinaryFor(platformArch) {
  const dir = join(cacheDir, `${NODE_VERSION}-${platformArch}`);
  const bin = join(dir, "node");
  if (existsSync(bin)) return bin;

  mkdirSync(dir, { recursive: true });
  const archiveName = `node-v${NODE_VERSION}-${platformArch}.tar.gz`;
  const archivePath = join(dir, archiveName);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
  console.log(`downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", archivePath, url], { stdio: "inherit" });
  execFileSync("tar", ["xzf", archivePath, "-C", dir, "--strip-components=2", `node-v${NODE_VERSION}-${platformArch}/bin/node`], {
    stdio: "inherit",
  });
  rmSync(archivePath);
  return bin;
}

const hostKey = `${hostPlatform()}-${hostArch()}`;
const targetNodeBin = nodeBinaryFor(target);
// Injecting into a same-arch target means the host can run that exact
// binary itself to generate the blob — no separate download. Cross-target
// (this repo's own darwin-arm64 prototype, built and tested from a Linux
// box) needs the host's own copy of the pinned version instead, since a
// foreign-arch binary can't run here at all.
const blobGenBin = hostKey === target ? targetNodeBin : nodeBinaryFor(hostKey);

const buildDir = join(here, ".out", target);
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const bundlePath = join(buildDir, "bundle.js");
await esbuild.build({
  entryPoints: [seaEntry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  alias: { "node-pty": join(here, "node-pty-shim.cjs") },
  outfile: bundlePath,
  logLevel: "info",
  // `resolveShipped` (src/paths.ts) still takes `import.meta.url` as an
  // argument for its non-SEA branch — esbuild rightly flags it as empty
  // under this cjs bundle, but `isSea()` is checked first and that branch
  // never reads the (correctly empty) value. True warning, dead code.
  logOverride: { "empty-import-meta": "silent" },
});

const blobPath = join(buildDir, "sea-prep.blob");
const seaConfigPath = join(buildDir, "sea-config.json");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      // Both false: a code cache or V8 snapshot is only valid on the exact
      // platform that produced it, and this can run cross-platform (see
      // blobGenBin above) — Node's own SEA docs call this out explicitly
      // for cross-platform builds.
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);
execFileSync(blobGenBin, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

const outDir = join(here, "dist", target);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const exePath = join(outDir, "anywh-relay");
cpSync(targetNodeBin, exePath);
chmodSync(exePath, 0o755);

execFileSync(
  join(relayDir, "node_modules", ".bin", "postject"),
  [exePath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE, "--macho-segment-name", "NODE_SEA"],
  { stdio: "inherit" },
);

// Ad-hoc (no identity, no keychain) — only possible on a real macOS host,
// which is what builds this target in CI (a `macos-14` runner). Signing
// here means the shipped tarball's binary is already valid; nothing in the
// Homebrew formula or on the user's machine has to sign it later.
if (hostPlatform() === "darwin") {
  execFileSync("codesign", ["--sign", "-", exePath], { stdio: "inherit" });
} else {
  console.warn(`built for ${target} on a non-macOS host — codesign it before running: codesign --sign - ${exePath}`);
}

// A flat, self-contained tree: the binary plus everything `resolveShipped`
// (src/paths.ts) and node-pty-shim.cjs expect to find beside it. Mirrors
// today's Linux tarball shape (relay + infra as siblings) with the SEA
// binary standing in for dist/ + node_modules.
cpSync(join(relayDir, "scripts"), join(outDir, "scripts"), { recursive: true });
cpSync(join(repoRoot, "infra"), join(outDir, "infra"), { recursive: true });

const ptySrc = join(relayDir, "node_modules", "node-pty");
const ptyDest = join(outDir, "node_modules", "node-pty");
mkdirSync(ptyDest, { recursive: true });
cpSync(join(ptySrc, "package.json"), join(ptyDest, "package.json"));
cpSync(join(ptySrc, "lib"), join(ptyDest, "lib"), { recursive: true });
cpSync(join(ptySrc, "prebuilds", target), join(ptyDest, "prebuilds", target), { recursive: true });

// The exec bit on `spawn-helper` doesn't reliably survive a plain
// copy/tar/scp round trip — found the hard way prototyping this: node-pty
// fails with a bare "posix_spawnp failed", no permission-denied message,
// if it's missing. Every file under this target's prebuild gets it
// explicitly rather than guessing which ones need it.
const prebuildDir = join(ptyDest, "prebuilds", target);
for (const entry of readdirSync(prebuildDir)) {
  chmodSync(join(prebuildDir, entry), 0o755);
}
if (hostPlatform() === "darwin") {
  for (const entry of readdirSync(prebuildDir)) {
    execFileSync("codesign", ["--sign", "-", join(prebuildDir, entry)], { stdio: "inherit" });
  }
}

console.log(`built ${outDir}`);
