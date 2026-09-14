import { beforeEach, describe, expect, it } from "vitest";
import { getProfiles, setProfiles } from "@/lib/profiles";
import { importProfile, parseImportProfileUrl } from "./profileImport";

beforeEach(() => {
  localStorage.clear();
});

describe("parseImportProfileUrl", () => {
  it("parses a well-formed direct-mode import-profile link", () => {
    const parsed = parseImportProfileUrl(
      "anywh://import-profile?host=1.2.3.4&port=8443&label=Paired%20device&token=s3cr3t",
    );
    expect(parsed).toEqual({ label: "Paired device", host: "1.2.3.4", port: 8443, connectToken: "s3cr3t" });
  });

  it("omits connectToken when the link carries no token param", () => {
    const parsed = parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&port=8443&label=Device");
    expect(parsed).toEqual({ label: "Device", host: "1.2.3.4", port: 8443, connectToken: undefined });
  });

  it("parses a well-formed tailnet-mode import-profile link (claimUrl/joinCode/brokerUrl)", () => {
    const parsed = parseImportProfileUrl(
      "anywh://import-profile?label=Paired%20device&claimUrl=https%3A%2F%2Fapi.example%2Fv1%2Fnodes%2Fclaim&joinCode=ABCDEF-GHJKMNPQ&brokerUrl=https%3A%2F%2Fapi.example%2Fv1%2Fconnect%2Fws-1",
    );
    expect(parsed).toEqual({
      label: "Paired device",
      claimUrl: "https://api.example/v1/nodes/claim",
      joinCode: "ABCDEF-GHJKMNPQ",
      brokerUrl: "https://api.example/v1/connect/ws-1",
    });
  });

  it("accepts a tailnet-mode link with no brokerUrl — the claim response can name one instead", () => {
    expect(parseImportProfileUrl("anywh://import-profile?label=Device&claimUrl=https://api.example/claim&joinCode=CODE")).toEqual({
      label: "Device",
      claimUrl: "https://api.example/claim",
      joinCode: "CODE",
      brokerUrl: undefined,
    });
  });

  it("rejects a tailnet-mode link missing claimUrl or joinCode — neither has a fallback anywhere", () => {
    expect(parseImportProfileUrl("anywh://import-profile?label=Device&joinCode=CODE&brokerUrl=https://api.example/connect")).toBeNull();
    expect(parseImportProfileUrl("anywh://import-profile?label=Device&claimUrl=https://api.example/claim")).toBeNull();
  });

  it("rejects a different scheme", () => {
    expect(parseImportProfileUrl("https://import-profile?host=1.2.3.4&port=8443&label=Device")).toBeNull();
  });

  it("rejects a different anywh:// action", () => {
    expect(parseImportProfileUrl("anywh://something-else?host=1.2.3.4&port=8443&label=Device")).toBeNull();
  });

  it("rejects a missing required field", () => {
    expect(parseImportProfileUrl("anywh://import-profile?port=8443&label=Device")).toBeNull();
    expect(parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&label=Device")).toBeNull();
    expect(parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&port=8443")).toBeNull();
  });

  it("rejects a non-numeric or non-positive port", () => {
    expect(parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&port=abc&label=Device")).toBeNull();
    expect(parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&port=0&label=Device")).toBeNull();
    expect(parseImportProfileUrl("anywh://import-profile?host=1.2.3.4&port=-1&label=Device")).toBeNull();
  });

  it("rejects a malformed URL outright", () => {
    expect(parseImportProfileUrl("not a url")).toBeNull();
  });
});

describe("importProfile", () => {
  // Direct mode never touches Tauri (no identity, no network claim), so
  // it's testable end to end here — same as before F4. The tailnet-mode
  // branch (claimTailnetBundle) is a thin Tauri-invoke+fetch wrapper with
  // no unit test of its own, same doctrine as tailnetSidecar.ts/
  // tailnetBroker.ts's own invoke wrappers; parseImportProfileUrl above
  // covers the pure parsing half.
  it("adds a new profile to the real store and returns its id", async () => {
    setProfiles([{ id: "existing", label: "Existing", host: "127.0.0.1", relayPort: 8765 }]);

    const id = await importProfile({ host: "1.2.3.4", port: 8443, label: "Paired device", connectToken: "s3cr3t" });

    const added = getProfiles().find((p) => p.id === id);
    // Saved before it is reached: `unverified` is what the setup pipeline
    // (or the shell's first session sync) clears once the machine answers.
    expect(added).toEqual({ id, label: "Paired device", host: "1.2.3.4", relayPort: 8443, connectToken: "s3cr3t", unverified: true });
    expect(getProfiles()).toHaveLength(2);
  });

  it("generates a fresh id on every call, even for identical params", async () => {
    setProfiles([]);
    const first = await importProfile({ host: "1.2.3.4", port: 8443, label: "Device" });
    const second = await importProfile({ host: "1.2.3.4", port: 8443, label: "Device" });
    expect(first).not.toBe(second);
    expect(getProfiles()).toHaveLength(2);
  });
});
