import { describe, expect, it } from "vitest";
import { installerSucceeded, needsLegacyUpgrade, parseUpgradeOutput, upgradeCommand, UPGRADE_EXIT_MARKER } from "@/lib/relay/legacyRelayUpgrade";

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
  it("on Linux pins the installer to the app's release, in the service's own tree, then restarts only that running service", () => {
    const command = upgradeCommand({ platform: "linux", profileId: "home", version: "0.2.50" }) ?? "";
    expect(command).toContain("curl -fsSL https://anywh.sh/install-relay | sh -s -- --version v0.2.50 --porcelain");
    expect(command).toContain("&& systemctl --user --no-block try-restart anywh-relay@home;");
    expect(command).toContain('run="$(systemctl --user show -p WorkingDirectory --value anywh-relay@home 2>/dev/null)"');
    expect(command).toContain('ANYWH_INSTALL_DIR="$dir"');
    expect(command).toMatch(new RegExp(`echo ${UPGRADE_EXIT_MARKER}=\\$\\?'$`));
    // One sh -c '...' with no inner single quote: the same under any shell.
    expect(command.trimStart().startsWith("sh -c '")).toBe(true);
    expect(command.trimStart().slice("sh -c '".length, -1)).not.toContain("'");
  });

  it("refuses before touching a file unless the service runs, from a release tree, not a checkout", () => {
    const command = upgradeCommand({ platform: "linux", profileId: "home", version: "0.2.50" }) ?? "";
    const guard = command.slice(0, command.indexOf("curl "));
    expect(guard).toContain("is-active anywh-relay@home");
    expect(guard).toContain('[ "$(basename "$run")" != relay ]');
    expect(guard).toContain('[ ! -f "$run/dist/server.js" ]');
    expect(guard).toContain('[ ! -f "$dir/infra/systemd/add-profile.sh" ]');
    expect(guard).toContain('[ -e "$dir/.git" ]');
    expect(guard).toContain(`echo "${UPGRADE_EXIT_MARKER}"=3; exit 0`);
    // The echoed command line reads as neither a failure nor an exit status.
    expect(parseUpgradeOutput(command)).toEqual({});
  });

  it("on macOS upgrades and restarts the Homebrew relay", () => {
    const command = upgradeCommand({ platform: "darwin", profileId: "default", version: "0.2.50" }) ?? "";
    expect(command).toContain("brew upgrade anywh-relay && brew services restart anywh-relay");
  });

  it("nothing for another platform, or for an id or version that could carry anything else", () => {
    expect(upgradeCommand({ platform: "win32", profileId: "home", version: "0.2.50" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", profileId: "home; rm -rf ~", version: "0.2.50" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", profileId: "home", version: "0.2.50'; reboot; '" })).toBeNull();
    expect(upgradeCommand({ platform: "linux", profileId: "home", version: "0.2.50", unit: "x; reboot" })).toBeNull();
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
