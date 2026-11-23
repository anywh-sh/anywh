import { describe, expect, it } from "vitest";
import { BREW_UPGRADE_STEPS, installerSucceeded, needsLegacyUpgrade, NOTHING_NEWER_EXIT, parseUpgradeOutput, upgradeCommand, UPGRADE_EXIT_MARKER } from "@/lib/relay/legacyRelayUpgrade";

describe("needsLegacyUpgrade", () => {
  it("is a relay on an older release that cannot update itself", () => {
    expect(needsLegacyUpgrade({ version: "0.2.40", features: ["bots"] }, "0.2.50")).toBe(true);
    expect(needsLegacyUpgrade({ version: "0.2.10" }, "0.2.50")).toBe(true);
  });

  it("never a relay that updates itself, one on the app's release or newer, or a build from source", () => {
    expect(needsLegacyUpgrade({ version: "0.2.40", features: ["self_update"] }, "0.2.50")).toBe(false);
    expect(needsLegacyUpgrade({ version: "0.2.50" }, "0.2.50")).toBe(false);
    expect(needsLegacyUpgrade({ version: "0.2.51" }, "0.2.50")).toBe(false);
    expect(needsLegacyUpgrade({ version: "0.0.0" }, "0.2.50")).toBe(false);
    expect(needsLegacyUpgrade({ version: "0.2.40" }, "0.0.0")).toBe(false);
    expect(needsLegacyUpgrade({}, "0.2.50")).toBe(false);
  });
});

describe("upgradeCommand", () => {
  const linux = (extra: Partial<Parameters<typeof upgradeCommand>[0]> = {}) => upgradeCommand({ platform: "linux", port: 8765, version: "0.2.50", ...extra }) ?? "";

  it("finds the service on the relay's machine, never from the app's profile id", () => {
    const command = linux();
    // The terminal's own cgroup names the relay's unit; else what listens on its port.
    expect(command).toContain('unit="$(sed -n "s|^.*/\\(anywh-relay@[a-z0-9-]*\\.service\\)$|\\1|p" /proc/self/cgroup | head -n 1)"');
    expect(command).toContain('ss -ltnpH "sport = :8765"');
    expect(command).not.toContain("anywh-relay@home");
  });

  it("downloads the installer to a file before running it, pinned to the app's release, then restarts only that running service", () => {
    const command = linux();
    expect(command).toContain('curl -fsSL https://anywh.sh/install-relay -o "$script" && sh "$script" --version v0.2.50 --porcelain && systemctl --user --no-block try-restart "$unit"');
    expect(command).toContain('ANYWH_INSTALL_DIR="$dir"');
    expect(command).toMatch(new RegExp(`echo ${UPGRADE_EXIT_MARKER}=\\$status'$`));
    // One sh -c '...' with no inner single quote: the same under any shell.
    expect(command.trimStart().startsWith("sh -c '")).toBe(true);
    expect(command.trimStart().slice("sh -c '".length, -1)).not.toContain("'");
  });

  it("refuses before touching a file unless that service runs, from a release tree, not a checkout", () => {
    const command = linux();
    const guard = command.slice(0, command.indexOf("curl "));
    expect(guard).toContain('[ -z "$unit" ]');
    expect(guard).toContain('is-active "$unit"');
    expect(guard).toContain('[ "$(basename "$run")" != relay ]');
    expect(guard).toContain('[ ! -f "$run/dist/server.js" ]');
    expect(guard).toContain('[ ! -f "$dir/infra/systemd/add-profile.sh" ]');
    expect(guard).toContain('[ -e "$dir/.git" ]');
    expect(guard).toContain(`echo "${UPGRADE_EXIT_MARKER}"=3; exit 0`);
    // The echoed command line reads as neither a failure nor an exit status.
    expect(parseUpgradeOutput(command)).toEqual({});
  });

  it("a test can name the unit outright", () => {
    expect(linux({ unit: "anywh-su-e2e.service" })).toContain("unit=anywh-su-e2e.service;");
  });

  it("on macOS upgrades and restarts the Homebrew relay", () => {
    expect(upgradeCommand({ platform: "darwin", port: 8765, version: "0.2.50" })).toContain(`then ${BREW_UPGRADE_STEPS}; else`);
  });

  it("on macOS restarts nothing when the tap has no newer relay, and never prints the marker with its number in the command line", () => {
    const command = upgradeCommand({ platform: "darwin", port: 8765, version: "0.2.50" }) ?? "";
    expect(command).toContain(`if brew outdated --quiet anywh-relay | grep -q anywh-relay; then`);
    expect(command).toContain(`else (exit ${String(NOTHING_NEWER_EXIT)}); fi`);
    // The terminal echoes the command back; only the run itself may read as
    // an exit status.
    expect(parseUpgradeOutput(command).exitCode).toBeUndefined();
  });

  it("nothing for another platform, or for a port, version or unit that could carry anything else", () => {
    expect(upgradeCommand({ platform: "win32", port: 8765, version: "0.2.50" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", port: 0, version: "0.2.50" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", port: 8765.5, version: "0.2.50" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", port: 8765, version: "0.2.50'; reboot; '" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", port: 8765, version: "0.2.50", unit: "x; reboot" })).toBeNull();
  });
});

describe("parseUpgradeOutput", () => {
  it("reads the exit status the command printed, not the echoed command line", () => {
    const echoed = ` sh -c '... ; echo ${UPGRADE_EXIT_MARKER}=$?'\r\n`;
    expect(parseUpgradeOutput(echoed)).toEqual({});
    expect(parseUpgradeOutput(`${echoed}Installed to /x\r\n${UPGRADE_EXIT_MARKER}=0\r\n`)).toEqual({ exitCode: 0 });
  });

  it("through colours and cursor moves, with the installer's reason when it failed", () => {
    const out = `\u001b[1mDownloading\u001b[0m\r\nANYWH fail download checksum_mismatch checksum mismatch for a.tar.gz\r\n\u001b[32m${UPGRADE_EXIT_MARKER}=1\u001b[0m`;
    expect(parseUpgradeOutput(out)).toEqual({ exitCode: 1, failure: "checksum mismatch for a.tar.gz" });
  });
});

describe("installerSucceeded", () => {
  it("is the installer's final ok line, not a step that finished", () => {
    expect(installerSucceeded("ANYWH done download asset=a\r\nANYWH done ok service=systemd install_dir=/x\r\n")).toBe(true);
    expect(installerSucceeded("\u001b[0mANYWH done ok\u001b[0m")).toBe(true);
    expect(installerSucceeded("ANYWH done install dir=/x\r\n")).toBe(false);
    expect(installerSucceeded("ANYWH fail download download_failed nope")).toBe(false);
  });
});
