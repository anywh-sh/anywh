// Builds the Go tailnet-sidecar into the name Tauri's `externalBin` expects
// (`binaries/tailnet-sidecar-<target-triple>`, plus `.exe` on Windows).
//
// This exists because forgetting it is silent and expensive: `tauri dev`
// happily bundles whatever binary is already sitting in `binaries/`, so a Go
// change appears to have no effect at all, and a Rust change that passes a
// flag the stale binary doesn't know makes the sidecar exit before printing
// LISTENING — which reads like a tailnet failure and is not one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..");

// Only the platforms this app is actually built for. Keyed by Node's own
// platform-arch so the host case needs no translation.
const TARGETS = {
  "win32-x64": { triple: "x86_64-pc-windows-msvc", goos: "windows", goarch: "amd64" },
  "darwin-arm64": { triple: "aarch64-apple-darwin", goos: "darwin", goarch: "arm64" },
  "darwin-x64": { triple: "x86_64-apple-darwin", goos: "darwin", goarch: "amd64" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", goos: "linux", goarch: "amd64" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", goos: "linux", goarch: "arm64" },
};

// iOS can't be keyed by process.platform/arch like the targets above: this
// script runs via the `pretauri` npm hook, which Xcode's own build phase
// triggers on the host Mac regardless of what it's building for, so
// process.platform/arch is always the Mac's, never the iOS one. Xcode does
// export PLATFORM_NAME ("iphoneos" for a device, "iphonesimulator" for the
// Simulator) and ARCHS into that phase's environment, which this hook
// inherits — that's the only reliable signal.
function iosTarget() {
  const platformName = process.env.PLATFORM_NAME;
  if (platformName !== "iphoneos" && platformName !== "iphonesimulator") return null;
  const goarch = (process.env.ARCHS ?? "").split(" ")[0] === "x86_64" ? "amd64" : "arm64";
  const triple =
    platformName === "iphoneos" ? "aarch64-apple-ios" : goarch === "amd64" ? "x86_64-apple-ios" : "aarch64-apple-ios-sim";
  return { triple, goos: "ios", goarch, sdk: platformName };
}

// `--target win32-x64` builds for another platform than this one. The sidecar
// is pure Go with no cgo, so this is a plain GOOS/GOARCH cross-build and
// needs no toolchain beyond Go itself — which means the machine that has Go
// can produce the binary for the machine that's doing the testing.
const targetFlag = process.argv.indexOf("--target");
const key = targetFlag === -1 ? `${process.platform}-${process.arch}` : process.argv[targetFlag + 1];

const target = iosTarget() ?? TARGETS[key];
if (!target) {
  console.error(`unknown target ${key} — known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const outDir = join(clientDir, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `tailnet-sidecar-${target.triple}${target.goos === "windows" ? ".exe" : ""}`);

// Unlike every other target, GOOS=ios requires cgo — the pure-Go syscall
// layer isn't ported for it — which means the Xcode-provided clang and the
// iOS SDK's sysroot, not just GOOS/GOARCH.
let buildEnv = { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" };
if (target.sdk) {
  const sdkPath = execFileSync("xcrun", ["--sdk", target.sdk, "--show-sdk-path"], { encoding: "utf8" }).trim();
  const cc = execFileSync("xcrun", ["--sdk", target.sdk, "-f", "clang"], { encoding: "utf8" }).trim();
  // Matches bundle.iOS.minimumSystemVersion in tauri.ios.conf.json — read
  // instead of duplicated so the two can't drift apart.
  const iosConf = JSON.parse(readFileSync(join(clientDir, "src-tauri", "tauri.ios.conf.json"), "utf8"));
  const minVersion = iosConf.bundle.iOS.minimumSystemVersion;
  const versionFlag = target.sdk === "iphoneos" ? `-mios-version-min=${minVersion}` : `-mios-simulator-version-min=${minVersion}`;
  const arch = target.goarch === "amd64" ? "x86_64" : "arm64";
  const cflags = `-isysroot ${sdkPath} ${versionFlag} -arch ${arch}`;
  buildEnv = { ...buildEnv, CGO_ENABLED: "1", CC: cc, CGO_CFLAGS: cflags, CGO_LDFLAGS: cflags };
}

try {
  execFileSync("go", ["build", "-o", out, "./cmd/tailnet-sidecar"], {
    cwd: join(clientDir, "tailnet-sidecar"),
    stdio: "inherit",
    env: buildEnv,
  });
} catch (err) {
  if (err.code === "ENOENT") {
    // The machine doing the testing doesn't necessarily have a Go toolchain,
    // and the raw spawn failure buries that under a stack trace.
    //
    // A binary already sitting at `out` means someone took the documented
    // route below — cross-built it elsewhere and copied it here. That is a
    // supported setup, not a failure, and since this script runs from
    // `pretauri` on every Tauri build now, exiting non-zero would make the
    // route unusable: the build it is meant to enable could never start.
    // Warn loudly instead, because the cost of a stale copy is the silent
    // one this script exists to prevent.
    if (existsSync(out)) {
      console.warn(
        `Go is not installed on this machine, so the sidecar was NOT rebuilt.\n` +
          `Using the existing binary as-is:\n` +
          `  ${out}\n` +
          `If the Go sources changed since that file was copied here, the build ` +
          `will bundle the stale one and your change will appear to do nothing.`,
      );
      process.exit(0);
    }
    console.error(
      `Go is not installed on this machine, so the sidecar can't be built here.\n` +
        `Build it on a machine that has Go, with the same target:\n` +
        `  npm run build:sidecar -- --target ${key}\n` +
        `then copy the result to this machine as:\n` +
        `  ${out}\n` +
        `The file name has to match exactly — Tauri's externalBin looks it up by name.`,
    );
    process.exit(1);
  }
  throw err;
}
console.log(`built ${out}`);
