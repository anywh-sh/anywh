// The relay's self-update: installs a given release over the running one,
// through the same installer a person runs by hand (install-relay.sh), so
// there is exactly one way a relay tree gets downloaded, verified against
// the release's SHA256SUMS and swapped in. This only installs; picking the
// new code up is the release watch's job (releaseWatch.ts), which restarts
// the relay and the agent host each at a moment when nothing is in flight.
//
// Supported only where a release tarball was installed with that installer:
// a `<install dir>/relay` + `<install dir>/infra` tree carrying a real
// release version. A source checkout (unreleased version) and the macOS
// builds (a Node SEA binary, owned by Homebrew or by the app) are refused.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { isNewerRelease, parseInstallerLine, parseRelease, type InstallerOutcome } from "./release.js";

/** `managed_elsewhere` is the Homebrew build, `managed_by_app` the relay
 * the macOS app ships and replaces on every app update. */
export type UpdateUnsupportedReason = "source_checkout" | "not_installer_layout" | "managed_elsewhere" | "managed_by_app";

export type RelayUpdateStatus =
  | { readonly state: "unsupported"; readonly reason: UpdateUnsupportedReason }
  | { readonly state: "idle" }
  | { readonly state: "installing"; readonly version: string }
  /** On disk, waiting for the release watch to restart onto it. */
  | { readonly state: "installed"; readonly version: string }
  /** `step` is the installer step that failed (`download`, `preflight`…),
   * absent when the installer never got to name one. `code` and `step` are
   * the installer's stable words; `message` is prose for a person. */
  | { readonly state: "failed"; readonly version: string; readonly code: string; readonly step?: string; readonly message: string };

export type StartUpdateResult =
  | { readonly ok: true; readonly status: RelayUpdateStatus }
  | { readonly ok: false; readonly code: "unsupported" | "bad_version" | "not_newer" | "busy" | "start_failed"; readonly status: RelayUpdateStatus };

export interface RelayUpdaterOptions {
  /** The release this relay runs. */
  readonly runningVersion: string;
  /** The relay package directory (where package.json sits). */
  readonly relayDir: string;
  /** Running as a single executable (the Homebrew build or the app's). */
  readonly sea: boolean;
  /** Run by the macOS app (`ANYWH_RELAY_MANAGED_BY_APP=1`): the app's
   * update is the relay's. */
  readonly managedByApp?: boolean;
  /** Register the systemd units as part of the install (`--mode prod`).
   * False under no service manager, where the installer touches no systemd. */
  readonly withService: boolean;
  /** Environment for the installer; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Called once a release is on disk. */
  readonly onInstalled?: (version: string) => void;
}

/** Where the installer sits next to an installed relay tree, else next to a
 * checkout's relay/ (tests and a source checkout). */
export function findInstaller(relayDir: string): string | null {
  const root = dirname(relayDir);
  for (const candidate of [join(root, "infra", "install-relay.sh"), join(root, "install-relay.sh")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function updateSupport(options: Pick<RelayUpdaterOptions, "runningVersion" | "relayDir" | "sea" | "managedByApp">): { readonly supported: true; readonly installer: string } | { readonly supported: false; readonly reason: UpdateUnsupportedReason } {
  if (options.sea) return { supported: false, reason: options.managedByApp ? "managed_by_app" : "managed_elsewhere" };
  if (parseRelease(options.runningVersion) === null) return { supported: false, reason: "source_checkout" };
  const root = dirname(options.relayDir);
  const installer = findInstaller(options.relayDir);
  if (basename(options.relayDir) !== "relay" || !existsSync(join(root, "infra", "systemd", "add-profile.sh")) || installer === null) {
    return { supported: false, reason: "not_installer_layout" };
  }
  return { supported: true, installer };
}

export class RelayUpdater {
  private current: RelayUpdateStatus;
  private readonly support: ReturnType<typeof updateSupport>;

  constructor(private readonly options: RelayUpdaterOptions) {
    this.support = updateSupport(options);
    this.current = this.support.supported ? { state: "idle" } : { state: "unsupported", reason: this.support.reason };
  }

  status(): RelayUpdateStatus {
    return this.current;
  }

  /** Begins installing `rawVersion` (`1.2.3` or `v1.2.3`). Never downgrades,
   * and one install at a time; asking again for the release already being
   * installed (or installed) is not an error. */
  start(rawVersion: string): StartUpdateResult {
    if (!this.support.supported) return { ok: false, code: "unsupported", status: this.current };
    const parsed = parseRelease(rawVersion);
    if (!parsed) return { ok: false, code: "bad_version", status: this.current };
    const version = parsed.join(".");
    const state = this.current.state;
    if ((state === "installing" || state === "installed") && "version" in this.current) {
      if (this.current.version === version) return { ok: true, status: this.current };
      if (state === "installing") return { ok: false, code: "busy", status: this.current };
      if (!isNewerRelease(version, this.current.version)) return { ok: false, code: "not_newer", status: this.current };
    }
    if (!isNewerRelease(version, this.options.runningVersion)) return { ok: false, code: "not_newer", status: this.current };
    this.current = { state: "installing", version };
    try {
      this.run(this.support.installer, version);
    } catch (error) {
      // Before the installer even started (no room in the temp dir, say):
      // a failed install, never left "installing".
      this.current = { state: "failed", version, code: "unexpected", message: error instanceof Error ? error.message : String(error) };
      return { ok: false, code: "start_failed", status: this.current };
    }
    return { ok: true, status: this.current };
  }

  private run(installer: string, version: string): void {
    // A copy runs, not the file itself: the install swaps out the very
    // directory the script lives in.
    const scratch = mkdtempSync(join(tmpdir(), "anywh-relay-update-"));
    const script = join(scratch, "install-relay.sh");
    try {
      copyFileSync(installer, script);
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
    const env = { ...(this.options.env ?? process.env) };
    env.ANYWH_INSTALL_DIR = dirname(this.options.relayDir);
    // A user unit's PATH is the service manager's default, which often lacks
    // the Node this relay runs on (nvm, a tarball in ~/.local). The installer
    // needs `node`, and renders the unit with whichever it finds first.
    env.PATH = [dirname(process.execPath), env.PATH ?? ""].filter(Boolean).join(delimiter);
    const args = [script, "--version", `v${version}`, "--porcelain", "--mode", this.options.withService ? "prod" : "dev"];
    console.log(`[relay] installing release ${version} (${installer})`);
    // Run from the scratch dir: the relay's own working directory is the
    // tree the install swaps out from under it.
    const child = spawn("sh", args, { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
    let outcome: InstallerOutcome | null = null;
    let buffered = "";
    const tail: string[] = [];
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const parsedLine = parseInstallerLine(line);
        if (parsedLine && (outcome === null || outcome.kind === "ok")) outcome = parsedLine;
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let finished = false;
    const finish = (code: number | null, spawnError?: Error): void => {
      // A failed spawn reports `error` and may still report `close`.
      if (finished) return;
      finished = true;
      rmSync(scratch, { recursive: true, force: true });
      const result: InstallerOutcome | null = outcome;
      if (!spawnError && code === 0 && result?.kind === "ok") {
        console.log(`[relay] release ${version} installed`);
        this.current = { state: "installed", version };
        this.options.onInstalled?.(version);
        return;
      }
      const failure =
        result?.kind === "fail"
          ? { code: result.code, step: result.step, message: result.message }
          : { code: "unexpected", message: spawnError?.message ?? `installer exited with status ${code ?? "unknown"}` };
      console.error(`[relay] installing release ${version} failed: ${failure.code} ${failure.message}\n${tail.join("\n")}`);
      this.current = { state: "failed", version, ...failure };
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  }
}
